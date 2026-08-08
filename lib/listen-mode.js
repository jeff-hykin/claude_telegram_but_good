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
    dbg("LISTEN", `spawning listen session ${sessionId} for group ${key} (${sessionTitle})`)
    return {
        sessionId,
        live: false,
        stateChanges: {
            chatState: { groupChatSessions: { [key]: { sessionId, spawnedAt: now } } },
            chatSessions: {
                [sessionId]: {
                    id: sessionId,
                    title: sessionTitle,
                    listenMode: true,
                    listenChatId: key,
                },
            },
        },
        effects: [{ type: "spawn_dtach_session", sessionId, title: sessionTitle }],
    }
}
