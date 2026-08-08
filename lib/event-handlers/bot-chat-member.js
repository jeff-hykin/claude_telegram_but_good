// ---------------------------------------------------------------------------
// bot_chat_member_updated handler.
//
// Fired when the bot's own membership in a chat changes. The only
// transition acted on is "added to a group": that group gets a session
// of its own, started in listen mode, so it reads the conversation from
// the moment the bot arrives instead of from the first message CBG
// happens to notice.
//
// Groups explicitly promoted to BotCenter are left alone — those already
// get the full topic/session treatment through session-register.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { loadAccess, classifyGroup } = await versionedImport("../access.js", import.meta)
const { ensureGroupSession } = await versionedImport("../listen-mode.js", import.meta)

const JOINED_STATUSES = ["member", "administrator", "creator"]

export default function handle(event, core) {
    const { chatId, chatType, chatTitle, oldStatus, newStatus } = event
    const isGroup = chatType === "group" || chatType === "supergroup"
    if (!isGroup || !JOINED_STATUSES.includes(newStatus) || JOINED_STATUSES.includes(oldStatus)) {
        return null
    }

    const access = loadAccess()
    if (classifyGroup(chatId, access) !== "groupChat") {
        dbg("CHAT-MEMBER", `added to BotCenter group ${chatId} — no listening session needed`)
        return null
    }

    const ensured = ensureGroupSession(core, chatId, chatTitle, event.ts)
    if (ensured.effects.length === 0) {
        dbg("CHAT-MEMBER", `added to ${chatId}, which already has session ${ensured.sessionId}`)
        return null
    }

    dbg("CHAT-MEMBER", `added to group ${chatId} (${chatTitle ?? "untitled"}) — listening via ${ensured.sessionId}`)
    return {
        stateChanges: ensured.stateChanges,
        effects: [
            { type: "record_group_chat", chatId: String(chatId) },
            ...ensured.effects,
        ],
    }
}
