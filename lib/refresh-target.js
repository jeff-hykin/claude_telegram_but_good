// lib/refresh-target.js — what /refresh is refreshing.
//
// Two shapes of topic can be refreshed, and everything that differs
// between them is decided here so commands/refresh.js can spawn once:
//
//   - a command center forum topic, keyed by its thread id
//   - a group chat cbg is listening to, keyed by the chat itself
//     (no forum topic exists, but the group has a session and a topic
//     memory of its own)
//
// `title` is the topic: the memory directory, and what the handoff is
// written against. `sessionTitle` is what the session is called in
// /list — the same thing in a command center topic, the group's own
// name in a group chat.

import { versionedImport } from "./version.js"

const { classifyGroup } = await versionedImport("./access.js", import.meta)
const { groupTopicName } = await versionedImport("./pure/group-topic.js", import.meta)

/**
 * @returns {{kind: "commandCenter"|"groupChat"}|{error: string}} plus
 *   `chatKey`, `threadKey`, `title`, `sessionTitle`, `existingSessionId`.
 */
export function resolveRefreshTarget(event, core, access) {
    const chatKey = String(event.chatId)
    const isCommandCenter = Boolean(access.commandCenterChatId) &&
        chatKey === String(access.commandCenterChatId)
    // classifyGroup calls anything that isn't a BotCenter a groupChat,
    // DMs included, so the chat type has to be checked as well.
    const isGroup = event.chatType === "group" || event.chatType === "supergroup"
    const isGroupChat = !isCommandCenter && isGroup &&
        classifyGroup(event.chatId, access) === "groupChat"

    if (!isCommandCenter && !isGroupChat) {
        return { error: "This command only works in the command center group, or in a group chat cbg is listening to." }
    }

    if (isGroupChat) {
        const binding = core.chatState?.groupChatSessions?.[chatKey] ?? null
        const chatTitle = event._ctx?.chat?.title ?? null
        // Sticky, exactly as on first spawn: a renamed group keeps
        // writing to the memory directory it already has.
        const title = binding?.topicName || groupTopicName(chatKey, chatTitle)
        return {
            kind: "groupChat",
            chatKey,
            threadKey: null,
            title,
            sessionTitle: chatTitle || title,
            existingSessionId: binding?.sessionId ?? null,
        }
    }

    if (!event.threadId) {
        return { error: "This command must be used inside a topic." }
    }

    const cc = core.chatState?.commandCenter ?? {}
    const threadKey = String(event.threadId)
    // Title always comes from the topic name — the Telegram topic is the
    // source of truth, not a command argument.
    const existingSessionId = cc.threadMap?.[threadKey] ?? null
    const topicName = cc.topicNames?.[threadKey] ?? null
    const existingTitle = existingSessionId ? core.chatSessions?.[existingSessionId]?.title : null
    const title = topicName || existingTitle || `Topic${threadKey}`
    return {
        kind: "commandCenter",
        chatKey,
        threadKey,
        title,
        sessionTitle: title,
        existingSessionId,
    }
}
