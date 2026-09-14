/**
 * access.json side effects.
 *
 * Handlers classify chats but never write; this module owns the
 * read-modify-write of the access file.
 */

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { readAccessFile, saveAccess } = await versionedImport("../access.js", import.meta)

/**
 * Append a group to the GroupChats list the first time CBG sees it, so
 * the bucket a group landed in is visible and editable instead of being
 * an invisible default.
 *
 * effect shape: { type: "record_group_chat", chatId: "-100..." }
 */
export function recordGroupChat(effect, _core) {
    const chatId = String(effect?.chatId ?? "")
    if (!chatId) {
        dbg("ACCESS", "record_group_chat: missing chatId")
        return
    }
    try {
        const access = readAccessFile()
        if (access.groupChats.includes(chatId) || access.botCenterGroups.includes(chatId)) {
            return
        }
        access.groupChats.push(chatId)
        saveAccess(access)
        dbg("ACCESS", `recorded ${chatId} in GroupChats`)
    } catch (e) {
        dbg("ACCESS", `record_group_chat failed for ${chatId}:`, e)
    }
}

/**
 * Add or remove allowlist entries, and clear pairing codes that have
 * been approved.
 *
 * The allowlist decides whose words reach an agent at all, so this is
 * the one write that must never be a blind overwrite: it re-reads the
 * file, edits it, and saves — the pairing flow writes to the same file
 * from the bot layer between our read and our write.
 *
 * effect shape: { type: "update_allowlist", add?: ["123"], remove?: ["456"], clearPending?: ["a4f91c"] }
 */
export function updateAllowlist(effect, _core) {
    const add = (effect?.add ?? []).map(String).filter(Boolean)
    const remove = (effect?.remove ?? []).map(String).filter(Boolean)
    const clearPending = (effect?.clearPending ?? []).map(String).filter(Boolean)
    if (add.length === 0 && remove.length === 0 && clearPending.length === 0) {
        dbg("ACCESS", "update_allowlist: nothing to do")
        return
    }
    try {
        const access = readAccessFile()
        const allowFrom = (access.allowFrom ?? []).map(String)
        const next = allowFrom.filter(id => !remove.includes(id))
        for (const id of add) {
            if (!next.includes(id)) { next.push(id) }
        }
        access.allowFrom = next
        for (const code of clearPending) {
            delete access.pending[code]
        }
        saveAccess(access)
        dbg("ACCESS", `allowlist updated: +[${add}] -[${remove}] paired[${clearPending}] → ${next.length} entries`)
    } catch (e) {
        dbg("ACCESS", "update_allowlist failed:", e)
    }
}
