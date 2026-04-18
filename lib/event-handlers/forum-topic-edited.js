// ---------------------------------------------------------------------------
// forum_topic_edited handler.
//
// Fired when a forum topic is renamed in Telegram. If the group is the
// command center and the topic is bound to a session, sync the session title.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"
import { renameSync } from "node:fs"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { loadAccess } = await versionedImport("../access.js", import.meta)
const { paths } = await versionedImport("../paths.js", import.meta)

export default function handle(event, core) {
    const { chatId, threadId, newTitle } = event

    if (!chatId || !threadId) {
        dbg("FORUM-EDITED", "missing chatId or threadId")
        return null
    }

    const access = loadAccess()
    if (String(chatId) !== String(access.commandCenterChatId)) {
        return null
    }

    if (!newTitle) {
        dbg("FORUM-EDITED", "no newTitle in event")
        return null
    }

    const cc = core.chatState?.commandCenter ?? {}
    const threadKey = String(threadId)
    const sessionId = cc.threadMap?.[threadKey]

    if (!sessionId) {
        dbg("FORUM-EDITED", `topic ${threadKey} not bound to any session`)
        return null
    }

    dbg("FORUM-EDITED", `syncing title for session ${sessionId} → "${newTitle}"`)

    // Rename the topic memory directory if the old name exists.
    const oldName = cc.topicNames?.[threadKey]
    if (oldName && oldName !== newTitle) {
        try {
            const oldDir = paths.topicDir(oldName)
            const newDir = paths.topicDir(newTitle)
            renameSync(oldDir, newDir)
            dbg("FORUM-EDITED", `renamed topic dir ${oldName} → ${newTitle}`)
        } catch (e) {
            // Not found is fine — the dir may not exist yet.
            if (e.code !== "ENOENT") {
                dbg("FORUM-EDITED", `rename topic dir failed:`, e)
            }
        }
    }

    const topicNames = { ...(cc.topicNames ?? {}), [threadKey]: newTitle }

    return {
        stateChanges: {
            chatState: {
                commandCenter: {
                    ...cc,
                    topicNames,
                },
            },
            chatSessions: {
                [sessionId]: { title: newTitle },
            },
        },
    }
}
