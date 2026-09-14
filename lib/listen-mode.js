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
// turn ends, so the session drops back to silent afterwards.
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

// A group whose session died would otherwise spawn a replacement on every
// single message. Spawning is slow (~20s to register) so re-attempts are
// spaced out rather than retried per message.
const RESPAWN_COOLDOWN_MS = 2 * 60 * 1000

/**
 * Why a `reply` to `chatId` must be refused, or null if it's allowed.
 */
export function listenBlockReason(session, chatId) {
    if (!session?.listenMode) { return null }
    if (session.listenUnlockedAt) { return null }
    const scope = session.listenChatId
    if (scope != null && String(scope) !== String(chatId)) { return null }
    return "You are in listen mode for this chat: you receive its messages for context but must not post in it. " +
        "Messages here are only for you to read. You may speak only when someone addresses the bot directly " +
        "(an @mention or a reply to one of your messages), which unlocks replies for that turn. " +
        "Do not call reply for this chat again until then."
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
    const handoff = prepareTopicHandoff({
        sessionId,
        title: topicName,
        oldSessionId: binding?.sessionId ?? null,
    })
    dbg("LISTEN", `spawning listen session ${sessionId} for group ${key} (${sessionTitle}, topic ${topicName})`)
    const messageQueue = [...(core.chatState?.messageQueue ?? []), {
        content: groupHandoffPrompt(sessionTitle, handoff),
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
                groupChatSessions: { [key]: { sessionId, spawnedAt: now, topicName } },
                messageQueue,
            },
            chatSessions: {
                [sessionId]: {
                    id: sessionId,
                    title: sessionTitle,
                    listenMode: true,
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
export function groupHandoffPrompt(chatTitle, handoff) {
    const lines = [
        `You are the listening session for the Telegram group "${chatTitle}".`,
        `You receive its messages from allowlisted senders only — anyone else in the group is invisible to you — and you may only post there when someone addresses the bot directly (an @mention, or a reply to one of your own messages). The daemon refuses any other reply, so do not answer this message — there is nothing to respond to yet.`,
    ]
    if (handoff.contextFile) {
        lines.push(`Read ${handoff.contextFile} for this group's memory and the tail of the previous session's conversation.`)
    }
    lines.push(
        `Your topic memory file is ${handoff.topicMemoryFile}.`,
        `Keep it updated as the conversation goes on — who is in the group, what they are working out, and anything you were asked to remember. It is all the next session in this group will know.`,
    )
    return lines.join("\n")
}
