// lib/command-scope.js — where a slash command may run, and what
// session it is about.
//
// Three kinds of chat can drive a session:
//
//   - a DM from an allowlisted sender
//   - a command center topic (the thread names the session)
//   - a group chat cbg is listening to, where an allowlisted sender can
//     manage the group's OWN session (the chat names it)
//
// The commands that answer about the whole fleet — /list, /list_tasks,
// /notes — deliberately do NOT use this: their output would be posted
// into a room with other people in it. This is for the commands that act
// on the one session the chat is already about.

import { versionedImport } from "./version.js"

const { classifyGroup } = await versionedImport("./access.js", import.meta)

/**
 * @returns {{allowed: boolean, isCommandCenter: boolean, isGroupChat: boolean, sessionId: string|null}}
 *   `sessionId` is the session this chat is about, when the chat names
 *   one: the topic's session in a command center, the group's own
 *   session in a group chat. Null in a DM, where there is nothing but
 *   the focused session to fall back on.
 */
export function commandScope(event, core, access) {
    const chatKey = String(event.chatId)
    const isCommandCenter = chatKey === String(access.commandCenterChatId ?? "")
    // classifyGroup calls anything that isn't a BotCenter a groupChat,
    // DMs included, so the chat type has to be checked as well.
    const isGroup = event.chatType === "group" || event.chatType === "supergroup"
    const isGroupChat = !isCommandCenter && isGroup &&
        classifyGroup(event.chatId, access) === "groupChat"
    const senderAllowed = (access.allowFrom ?? []).includes(String(event.userId ?? ""))

    // Being in the command center IS the trust boundary there; everywhere
    // else the sender has to be on the allowlist.
    const allowed = isCommandCenter ||
        ((event.chatType === "private" || isGroupChat) && senderAllowed)

    let sessionId = null
    if (isCommandCenter && event.threadId) {
        sessionId = core.chatState?.commandCenter?.threadMap?.[String(event.threadId)] ?? null
    } else if (isGroupChat) {
        sessionId = core.chatState?.groupChatSessions?.[chatKey]?.sessionId ?? null
    }

    return { allowed, isCommandCenter, isGroupChat, sessionId }
}
