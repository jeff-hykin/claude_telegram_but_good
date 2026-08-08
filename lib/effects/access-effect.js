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
