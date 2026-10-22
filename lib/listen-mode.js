// ---------------------------------------------------------------------------
// lib/listen-mode.js — "listen mode": a session that reads a chat but is
// not allowed to speak in it.
//
// The silence is enforced by the daemon (handleReply refuses the `reply`
// tool call) rather than by instructing the agent. A prompt-level rule is
// a suggestion; the point of sitting in someone else's group chat is that
// the bot stays quiet even when the model is sure it has something worth
// saying.
//
// A listening session is unlocked for exactly one turn whenever an inbound
// message addresses the bot. claude-hook-stop clears the unlock when that
// turn ends, so the session drops back to silent afterwards — except while
// a reply to the listened-to chat is still owed, since an addressed message
// can arrive while the previous turn is still finishing and the older turn's
// Stop must not revoke what it just granted.
//
// A refused reply is not thrown away: `planHeldReply` forwards it to the
// session's own command-center topic. Silent work is the failure mode that
// matters here — a listening session that researches an answer and cannot
// speak looks exactly like a dead one from the chat's side.
//
// Scope: `listenChatId` limits the block to one chat, which is what the
// auto-created group sessions use — the session can still talk to its
// command-center topic, so the operator can interrogate it privately while
// the group hears nothing. `/listen` with no bound chat blocks everywhere.
// ---------------------------------------------------------------------------

import { versionedImport } from "./version.js"

const { dbg } = await versionedImport("./logging.js", import.meta)
const { generateName } = await versionedImport("./pure/ids.js", import.meta)
const { groupTopicName } = await versionedImport("./pure/group-topic.js", import.meta)
const { prepareTopicHandoff } = await versionedImport("./topic-context.js", import.meta)
const { makeReplyTo, sendEffect } = await versionedImport("./pure/reply-to.js", import.meta)

// A group whose session died would otherwise spawn a replacement on every
// single message. Spawning is slow (~20s to register) so re-attempts are
// spaced out rather than retried per message.
const RESPAWN_COOLDOWN_MS = 2 * 60 * 1000

/**
 * Whether `chatId` is a chat this session is only listening to — true
 * even during an unlocked turn. Anything that would put the session's
 * internals in front of that chat's members (a screen snapshot, say)
 * has to key off this rather than off the momentary unlock.
 *
 * Pass `core` wherever it is available. For a group cbg is bound to, the
 * GROUP's setting is the truth and the session flag is only a cache of
 * it, written when an inbound message arrives — so between a `/listen`
 * (or a change of default) and the group's next message the flag is
 * stale, and the session gets refused for a rule nobody holds any more.
 * Reading the binding closes that window.
 */
export function listensToChat(session, chatId, core = null) {
    const binding = core?.chatState?.groupChatSessions?.[String(chatId)]
    if (binding && String(binding.sessionId ?? "") === String(session?.id ?? "")) {
        return binding.listenMode === true
    }
    if (!session?.listenMode) { return false }
    const scope = session.listenChatId
    return scope == null || String(scope) === String(chatId)
}

/**
 * Why a `reply` to `chatId` must be refused, or null if it's allowed.
 */
export function listenBlockReason(session, chatId, core = null) {
    if (!listensToChat(session, chatId, core)) { return null }
    if (session.listenUnlockedAt) { return null }
    return "You are in listen mode for this chat: you receive its messages for context but must not post in it. " +
        "Messages here are only for you to read. You may speak only when someone addresses the bot directly " +
        "(an @mention or a reply to one of your messages), which unlocks replies for that turn. " +
        "Do not call reply for this chat again until then. " +
        "React to the message with 👍 instead (the react tool is not blocked here) so the people in the chat " +
        "can see it was read."
}

// A held reply is the agent's own prose and can be arbitrarily long; the
// operator only needs to see it, not the whole essay.
const HELD_REPLY_MAX_CHARS = 3000

/**
 * The command-center topic belonging to a session, or null if it has none.
 *
 * Deliberately does NOT fall back to `lastInbound` the way
 * `replyToForSession` does: for a listening session the last inbound chat
 * IS the chat it is banned from, so a fallback would post the held reply
 * into exactly the group the block exists to keep quiet.
 */
export function heldReplyTarget(core, sessionId) {
    const cc = core?.chatState?.commandCenter ?? {}
    const threadId = cc.topicMap?.[sessionId] ?? null
    if (!cc.chatId || threadId == null) { return null }
    return makeReplyTo({ chatId: String(cc.chatId), threadId: String(threadId), setBy: "listen-mode/held-reply" })
}

/**
 * What to do with a reply listen mode just refused: show it to the
 * operator in the session's own command-center topic so the work is
 * visible, and tell the agent that its text was not lost.
 *
 * Returns `{ effects, note, patch }`. Everything is empty when the
 * session has no command-center topic, or when a held reply was already
 * announced this turn (claude-hook-stop clears the flag on Stop) — an
 * agent that retries `reply` must not be able to flood the topic.
 */
export function planHeldReply(core, sessionId, chatId, text) {
    const session = core?.chatSessions?.[sessionId]
    const target = heldReplyTarget(core, sessionId)
    if (!target || session?.listenHeldForwarded) {
        return { effects: [], note: "", patch: null }
    }
    const body = text.length > HELD_REPLY_MAX_CHARS
        ? text.slice(0, HELD_REPLY_MAX_CHARS) + "\n…(truncated)"
        : text
    // Plain text, no parse_mode: this is the agent's raw prose, and a
    // markdown parse failure here would lose the very message whose
    // whole purpose is to stop work from going missing.
    const notice = [
        `Held a reply to chat ${chatId} — listen mode: nobody addressed the bot there, so nothing was posted.`,
        "",
        body,
        "",
        "To let it answer in the chat itself, @mention the bot there or reply to one of its own messages.",
    ].join("\n")
    return {
        effects: [sendEffect(target, notice)],
        note: " Your text was NOT lost — it has been posted to this session's command-center topic, so the operator can read it there.",
        patch: { listenHeldForwarded: true },
    }
}

/**
 * The session bound to a group chat, plus the patch needed to create one
 * if there isn't a live session yet.
 *
 * Returns `{ sessionId, live, stateChanges, effects }`. `live` is false
 * while a freshly spawned session is still starting up — callers should
 * drop the message rather than queue it, since a group's backlog is
 * ambient chatter, not instructions waiting to be executed.
 */
export function ensureGroupSession(core, chatId, title, now) {
    const key = String(chatId)
    const binding = core.chatState?.groupChatSessions?.[key] ?? null
    const bound = binding?.sessionId ? core.chatSessions?.[binding.sessionId] : null
    if (bound?._conn) {
        return { sessionId: binding.sessionId, live: true, stateChanges: {}, effects: [] }
    }
    if (binding && now - (binding.spawnedAt ?? 0) < RESPAWN_COOLDOWN_MS) {
        return { sessionId: binding.sessionId ?? null, live: false, stateChanges: {}, effects: [] }
    }

    const sessionId = generateName()
    const sessionTitle = title || `group ${key}`
    // The memory directory is chosen once, on the first spawn, and then
    // kept in the binding: renaming the Telegram group later must not
    // orphan everything written about it so far.
    const topicName = binding?.topicName || groupTopicName(key, title)
    // A group cbg is added to answers its members by default: only
    // allowlisted senders reach it at all, so the room is already the
    // trust boundary, and a bot that sits there silently reads exactly
    // like a dead one. `/listen on` inside the group buys the silence
    // back. Either way it is a decision about the GROUP, not about one
    // session, so it is kept in the binding and survives a respawn.
    const listenMode = binding?.listenMode === true
    const handoff = prepareTopicHandoff({
        sessionId,
        title: topicName,
        oldSessionId: binding?.sessionId ?? null,
    })
    dbg("LISTEN", `spawning listen session ${sessionId} for group ${key} (${sessionTitle}, topic ${topicName})`)
    const messageQueue = [...(core.chatState?.messageQueue ?? []), {
        content: groupHandoffPrompt(sessionTitle, handoff, listenMode),
        meta: { source: "group-listen-context" },
        queuedAt: now,
        // Targeted: a group's handoff must reach its own session, not
        // whichever session happens to be focused when it registers.
        targetSessionId: sessionId,
    }]
    return {
        sessionId,
        live: false,
        stateChanges: {
            chatState: {
                groupChatSessions: { [key]: { sessionId, spawnedAt: now, topicName, listenMode } },
                messageQueue,
            },
            chatSessions: {
                [sessionId]: {
                    id: sessionId,
                    title: sessionTitle,
                    listenMode,
                    listenChatId: key,
                },
            },
        },
        effects: [{ type: "spawn_dtach_session", sessionId, title: sessionTitle, topicName }],
    }
}

/**
 * What a freshly spawned group session is told on startup. It is not the
 * ordinary topic handoff: that one ends with "ask how you can help",
 * which is the one thing a listening session must not do.
 */
export function groupHandoffPrompt(chatTitle, handoff, listenMode = true) {
    const lines = [
        listenMode
            ? `You are the listening session for the Telegram group "${chatTitle}".`
            : `You are the session for the Telegram group "${chatTitle}", and you take part in it like any other member.`,
        listenMode
            ? `You receive its messages from allowlisted senders only — anyone else in the group is invisible to you — and you may only post there when someone addresses the bot directly (an @mention, or a reply to one of your own messages). The daemon refuses any other reply, so do not answer this message — there is nothing to respond to yet.`
            : `You receive its messages from allowlisted senders only — anyone else in the group is invisible to you. Listen mode is off for this group, so you answer every message you are given, @mentioned or not. Do not answer this message, though — there is nothing to respond to yet.`,
    ]
    if (handoff.contextFile) {
        lines.push(`Read ${handoff.contextFile} for this group's memory and the tail of the previous session's conversation.`)
    }
    lines.push(
        `When a message needs no text answer of its own — or you are not allowed to send one — react to it with 👍 using the react tool, so the people in the chat can see it was read instead of wondering whether the bot is dead.`,
        `Your topic memory file is ${handoff.topicMemoryFile}.`,
        `Keep it updated as the conversation goes on — who is in the group, what they are working out, and anything you were asked to remember. It is all the next session in this group will know.`,
    )
    return lines.join("\n")
}
