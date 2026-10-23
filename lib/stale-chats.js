// ---------------------------------------------------------------------------
// lib/stale-chats.js
//
// A topic session is "stale" once it has sat idle past the prompt-cache TTL
// (config `stale_chat_after_ms`): its next message re-pays its whole context.
// Two consumers:
//   - stale-chat-check.js tells the topic "consume 137k tokens?" once per idle
//     stretch.
//   - deliverOrRefresh() lets reminders, interval hooks and tell_session swap a
//     stale session for a fresh /refresh-style one, then deliver to that.
// ---------------------------------------------------------------------------

import { versionedImport } from "./version.js"

const { dbg } = await versionedImport("./logging.js", import.meta)
const { getStaleChatAfterMs, getStaleChatAutoRefresh } = await versionedImport("./config-manager.js", import.meta)
const { generateName } = await versionedImport("./pure/ids.js", import.meta)
const { prepareTopicHandoff } = await versionedImport("./topic-context.js", import.meta)
const { escapeMarkdown: esc } = await versionedImport("./pure/markdown.js", import.meta)
const { replyToForSession, sendEffect } = await versionedImport("./pure/reply-to.js", import.meta)
const { DEFAULT_BACKEND_NAME } = await versionedImport("./agent-backends/index.js", import.meta)

/** Idle, connected, and its last turn ended longer ago than the cache lives. */
export function isStaleSession(session, now = Date.now(), afterMs = getStaleChatAfterMs()) {
    if (!session?._conn || afterMs <= 0 || typeof session.lastStopAt !== "number") {
        return false
    }
    if (session.status && session.status !== "idle") {
        return false
    }
    return now - session.lastStopAt >= afterMs
}

/** The command-center thread a session is bound to, or null (DMs, groups, workers). */
export function topicThreadKey(core, sessionId) {
    const cc = core.chatState?.commandCenter ?? {}
    const threadKey = cc.topicMap?.[sessionId]
    return threadKey != null && cc.threadMap?.[String(threadKey)] === sessionId ? String(threadKey) : null
}

/**
 * What /refresh does in a command-center topic: spawn a new session, retire
 * the old one, rebind the topic, and queue the handoff prompt followed by
 * `followUps` ({ content, meta }) for the new session.
 *
 * @returns {{ sessionId: string, note: string, stateChanges: object, effects: object[] }}
 */
export function buildTopicRefresh(core, { threadKey, title, sessionTitle = title, existingSessionId, backend, followUps = [], focus = true }) {
    const cc = core.chatState?.commandCenter ?? {}
    const sessionId = generateName()
    const handoff = prepareTopicHandoff({ sessionId, title, oldSessionId: existingSessionId })

    const effects = [{ type: "spawn_dtach_session", sessionId, title: sessionTitle, topicName: title, backend }]

    // Kill old session: send /exit gracefully, then schedule a
    // force-close as fallback in case it doesn't exit cleanly.
    if (existingSessionId && core.chatSessions?.[existingSessionId]) {
        if (backend === DEFAULT_BACKEND_NAME) {
            effects.push({ type: "send_text_to_claude", sessionId: existingSessionId, text: "/exit" })
        }
        effects.push({
            type: "set_timer",
            delayMs: backend === DEFAULT_BACKEND_NAME ? 15000 : 0,
            event: { type: "session_force_close", sessionId: existingSessionId },
        })
        dbg("REFRESH", `killing old session ${existingSessionId}`)
    }

    const topicMap = { ...(cc.topicMap ?? {}) }
    const threadMap = { ...(cc.threadMap ?? {}) }
    const topicNames = { ...(cc.topicNames ?? {}) }
    if (existingSessionId) {
        delete topicMap[existingSessionId]
    }
    topicMap[sessionId] = threadKey
    threadMap[threadKey] = sessionId
    topicNames[threadKey] = title

    // Queued rather than typed in, so they reach the session through the event
    // queue once it registers — no dtach race with user messages.
    const queuedAt = Date.now()
    const messageQueue = [
        ...(core.chatState?.messageQueue ?? []),
        { content: handoff.prompt, targetSessionId: sessionId, meta: { source: "refresh-context" }, queuedAt },
        ...followUps.map(({ content, meta }) => ({ content, meta, targetSessionId: sessionId, queuedAt })),
    ]
    dbg("REFRESH", `queued handoff + ${followUps.length} follow-up(s) for ${sessionId}${handoff.note}`)

    return {
        sessionId,
        note: handoff.note,
        stateChanges: {
            chatState: {
                ...(focus ? { pendingFocusId: sessionId } : {}),
                messageQueue,
                commandCenter: {
                    ...cc,
                    topicMap,
                    threadMap,
                    topicNames,
                    topicBackends: { ...(cc.topicBackends ?? {}), [threadKey]: backend },
                },
            },
        },
        effects,
    }
}

/**
 * Deliver `content` to `sessionId`, unless it is a stale topic session — then
 * refresh the topic first and hand the message to the new session instead.
 *
 * @returns {{ refreshedTo: string|null, stateChanges: object, effects: object[] }}
 */
export function deliverOrRefresh(core, sessionId, content, meta = {}) {
    const deliver = { refreshedTo: null, stateChanges: {}, effects: [{ type: "deliver_channel_event", sessionId, content, meta }] }
    const session = core.chatSessions?.[sessionId]
    const threadKey = topicThreadKey(core, sessionId)
    if (!threadKey || !getStaleChatAutoRefresh() || !isStaleSession(session)) {
        return deliver
    }
    const cc = core.chatState?.commandCenter ?? {}
    const title = cc.topicNames?.[threadKey] || session.title || `Topic${threadKey}`
    try {
        const refresh = buildTopicRefresh(core, {
            threadKey,
            title,
            existingSessionId: sessionId,
            backend: session.backend ?? DEFAULT_BACKEND_NAME,
            followUps: [{ content, meta }],
            focus: false,
        })
        const idleMinutes = Math.round((Date.now() - session.lastStopAt) / 60_000)
        dbg("STALE", `${sessionId} idle ${idleMinutes}m — refreshing to ${refresh.sessionId} before delivering ${meta.source ?? "message"}`)
        const what = String(meta.source ?? "message").replace(/_/g, " ")
        refresh.effects.push(sendEffect(
            replyToForSession(sessionId, core, "stale-refresh"),
            `Stale chat (idle ${idleMinutes} min): refreshed to \`${esc(refresh.sessionId)}\` before delivering a ${esc(what)}${refresh.note}`,
            { parse_mode: "Markdown" },
        ))
        return { refreshedTo: refresh.sessionId, stateChanges: refresh.stateChanges, effects: refresh.effects }
    } catch (e) {
        dbg("STALE", `refresh of ${sessionId} failed, delivering to it as-is:`, e)
        return deliver
    }
}
