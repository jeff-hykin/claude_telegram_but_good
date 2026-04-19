// commands/archive.js — Action-returning hot command.
//
// Saves topic chat history to cold storage, deletes the Telegram topic,
// and unbinds the session from the topic map.

import { versionedImport } from "../lib/version.js"
const { dbg } = await versionedImport("../lib/logging.js", import.meta)
const { loadAccess } = await versionedImport("../lib/access.js", import.meta)
const { makeReplyTo, sendEffect } = await versionedImport("../lib/pure/reply-to.js", import.meta)

export const descriptions = {
    archive: "Archive and close a topic",
}

export const commands = {
    archive: async (event, core) => {
        const access = loadAccess()
        const ccChatId = access.commandCenterChatId
        const replyTo = makeReplyTo(event, "cmd/archive")

        if (!ccChatId || String(event.chatId) !== String(ccChatId)) {
            return { effects: [sendEffect(replyTo, "This command only works in the command center group.", { parse_mode: "HTML" })] }
        }

        const threadId = event.threadId
        if (!threadId) {
            return { effects: [sendEffect(replyTo, "This command must be used inside a topic.", { parse_mode: "HTML" })] }
        }

        const cc = core.chatState?.commandCenter ?? {}
        const threadKey = String(threadId)
        const sessionId = cc.threadMap?.[threadKey]

        // Save cold storage entry before deleting
        const effects = [{
            type: "cold_append",
            stream: "messages",
            entry: {
                type: "topic_archived",
                chatId: event.chatId,
                threadId: threadKey,
                sessionId: sessionId ?? null,
                ts: Date.now(),
            },
        }]

        // Notify before deleting the topic
        effects.push(sendEffect(replyTo, `Archiving topic${sessionId ? ` (session ${sessionId})` : ""}...`, { parse_mode: "HTML" }))

        // Delete the topic from Telegram
        effects.push({
            type: "delete_thread",
            chatId: event.chatId,
            threadId: threadKey,
        })

        // Update maps
        const topicMap = { ...(cc.topicMap ?? {}) }
        const threadMap = { ...(cc.threadMap ?? {}) }
        if (sessionId) { delete topicMap[sessionId] }
        delete threadMap[threadKey]

        dbg("ARCHIVE", `archived topic ${threadKey}${sessionId ? ` (session ${sessionId})` : ""}`)

        return {
            stateChanges: {
                chatState: {
                    commandCenter: {
                        ...cc,
                        topicMap,
                        threadMap,
                    },
                },
            },
            effects,
        }
    },
}
