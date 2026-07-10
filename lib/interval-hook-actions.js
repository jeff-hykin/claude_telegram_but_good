// lib/interval-hook-actions.js
//
// Pure-ish helpers for the interval-hooks feature, mirroring
// lib/scheduled-task-actions.js. An "interval hook" is an agent-written
// JS decision function that runs on a recurring interval. Each run the
// function returns null (do nothing) or a string (message a topic's
// agent). Unlike scheduled tasks, an interval hook does NOT always spin
// up a Claude worker — the JS decides whether the topic agent needs to
// be involved at all.

import { versionedImport } from "./version.js"
const { dbg } = await versionedImport("./logging.js", import.meta)
const { generateName } = await versionedImport("./pure/ids.js", import.meta)

/**
 * Find an interval hook by id across all chats. Returns
 * `{ chatId, hook }` or null.
 */
export function findIntervalHook(specialData, hookId) {
    const byChat = specialData?.intervalHookByChatId ?? {}
    for (const [chatId, hooks] of Object.entries(byChat)) {
        if (hooks && hooks[hookId] !== undefined) {
            return { chatId, hook: hooks[hookId] }
        }
    }
    return null
}

/**
 * Render the standard inline command row for an interval hook.
 */
export function intervalHookCommandLinks(hookId) {
    return [
        `/interval_hook_view_${hookId}`,
        `/interval_hook_off_${hookId}`,
    ].join("\n")
}

/**
 * Build an Action that hot-deactivates an interval hook from the Telegram
 * command path (/interval_hook_off_<id>). Mirrors the MCP deactivate
 * handler but replies via Telegram instead of ipc_respond.
 */
export function buildIntervalHookOffAction(core, chatId, hookId) {
    const found = findIntervalHook(core.specialData, hookId)
    if (!found) {
        return { effects: [{ type: "send_text_to_user", chatId, text: `Unknown interval hook: ${hookId}`, options: {} }] }
    }
    if (!found.hook.active) {
        return { effects: [{ type: "send_text_to_user", chatId, text: `Interval hook ${hookId} is already deactivated.`, options: {} }] }
    }
    return {
        stateChanges: {
            specialData: {
                intervalHookByChatId: {
                    [found.chatId]: { [hookId]: { active: false } },
                },
            },
        },
        effects: [
            { type: "interval_hook_timer_clear", hookId },
            { type: "cold_append", stream: "interval-hooks", entry: { hookId, chatId: found.chatId, requestedBy: chatId, event: "deactivated" } },
            { type: "send_text_to_user", chatId, text: `Deactivated interval hook ${hookId}.`, options: {} },
        ],
    }
}

/**
 * Build an Action that shows the details of an interval hook
 * (/interval_hook_view_<id>).
 */
export function buildIntervalHookViewAction(core, chatId, hookId) {
    const found = findIntervalHook(core.specialData, hookId)
    if (!found) {
        return { effects: [{ type: "send_text_to_user", chatId, text: `Unknown interval hook: ${hookId}`, options: {} }] }
    }
    const hook = found.hook
    const tr = hook.tracking ?? {}
    const lines = [
        `Interval hook ${hook.id}`,
        `Title: ${hook.title}`,
        `Topic: ${hook.topic}`,
        `Active: ${hook.active ? "yes" : "no"}`,
        `Rule: ${JSON.stringify(hook.rule)}`,
        `Runs: ${tr.totalRuns ?? 0}`,
        `Last: ${tr.lastRunStatus ?? "—"}${tr.lastRunAt ? ` at ${tr.lastRunAt}` : ""}`,
        `Next fire: ${tr.nextFireAt ?? "—"}`,
    ]
    return { effects: [{ type: "send_text_to_user", chatId, text: lines.join("\n"), options: {} }] }
}

/**
 * Resolve a topic name to its Telegram thread key by reverse-lookup
 * against commandCenter.topicNames (case-insensitive). Returns the
 * threadKey string or null.
 */
export function resolveTopicThreadKey(cc, topic) {
    const topicNames = cc?.topicNames ?? {}
    const needle = String(topic ?? "").toLowerCase()
    for (const [threadKey, name] of Object.entries(topicNames)) {
        if (String(name).toLowerCase() === needle) {
            return threadKey
        }
    }
    return null
}

/**
 * Build an Action that delivers `content` to a topic's bound agent,
 * resurrecting the topic session if it is dead/missing.
 *
 * Two cases:
 *   - a live session (`_conn`) is bound to the topic → deliver_channel_event.
 *   - no live session → spawn a fresh session bound to the topic, rebind
 *     the topic maps, and queue the message as a TARGETED messageQueue
 *     entry (drained by session-register once the shim connects).
 *
 * If the topic has never existed as a Telegram topic (no threadKey),
 * there is nothing to resurrect — we log and return an empty Action so
 * the caller's other effects (cold_append, tracking) still apply.
 *
 * @returns {{ stateChanges?, effects? }}
 */
export function buildTopicDeliveryAction(core, topic, content, meta = {}) {
    const cc = core.chatState?.commandCenter ?? {}
    const threadKey = resolveTopicThreadKey(cc, topic)
    if (!threadKey) {
        dbg("IHOOK-DELIVER", `topic "${topic}" has no Telegram thread; cannot deliver/resurrect`)
        return { effects: [] }
    }

    const boundSessionId = cc.threadMap?.[threadKey]
    const boundSession = boundSessionId ? core.chatSessions?.[boundSessionId] : null

    // Live session bound to the topic — deliver directly.
    if (boundSession?._conn) {
        return {
            effects: [
                {
                    type: "deliver_channel_event",
                    sessionId: boundSessionId,
                    content,
                    meta,
                },
            ],
        }
    }

    // Dead or missing — resurrect a session bound to this topic.
    const title = cc.topicNames?.[threadKey] || `Topic${threadKey}`
    const newSessionId = generateName()

    // Rebind topic maps: unbind the stale session (undefined deletes the
    // key via mergeSessionData) and point the topic at the new session.
    const topicMapPatch = { [newSessionId]: threadKey }
    if (boundSessionId) { topicMapPatch[boundSessionId] = undefined }

    const messageQueue = [...(core.chatState?.messageQueue ?? [])]
    messageQueue.push({
        targetSessionId: newSessionId,
        content,
        meta,
        queuedAt: Date.now(),
    })

    dbg("IHOOK-DELIVER", `resurrecting topic "${title}" (thread ${threadKey}) as ${newSessionId}`)

    return {
        stateChanges: {
            chatState: {
                pendingFocusId: newSessionId,
                messageQueue,
                commandCenter: {
                    topicMap: topicMapPatch,
                    threadMap: { [threadKey]: newSessionId },
                    topicNames: { [threadKey]: title },
                },
            },
        },
        effects: [
            { type: "spawn_dtach_session", sessionId: newSessionId, title, topicName: title },
        ],
    }
}
