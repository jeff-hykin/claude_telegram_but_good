// ---------------------------------------------------------------------------
// forum_topic_created handler.
//
// Fired when a user manually creates a forum topic in a Telegram supergroup.
// If the group is the command center, bind the topic to an existing session
// (by title match) or spawn a new session for it.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { loadAccess } = await versionedImport("../access.js", import.meta)

export default function handle(event, core) {
    const { chatId, threadId, topicTitle } = event

    if (!chatId || !threadId) {
        dbg("FORUM-CREATED", "missing chatId or threadId")
        return null
    }

    const access = loadAccess()
    if (String(chatId) !== String(access.commandCenterChatId)) {
        dbg("FORUM-CREATED", `ignoring topic in non-command-center group ${chatId}`)
        return null
    }

    if (!topicTitle || topicTitle.toLowerCase() === "general") {
        return {
            effects: [{
                type: "send_text_to_user",
                chatId,
                text: "Cannot use \"General\" as a session name.",
                options: { message_thread_id: Number(threadId) },
            }],
        }
    }

    // Check if an existing session has this title
    const sessions = core.chatSessions ?? {}
    let matchedSessionId = null
    for (const [sid, sess] of Object.entries(sessions)) {
        if (sess?.title === topicTitle) {
            matchedSessionId = sid
            break
        }
    }

    const cc = core.chatState?.commandCenter ?? {}
    const topicMap = { ...(cc.topicMap ?? {}) }
    const threadMap = { ...(cc.threadMap ?? {}) }
    const threadKey = String(threadId)

    if (matchedSessionId) {
        // Bind existing session to this topic
        topicMap[matchedSessionId] = threadKey
        threadMap[threadKey] = matchedSessionId
        dbg("FORUM-CREATED", `bound existing session ${matchedSessionId} to topic ${threadKey}`)

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
            effects: [{
                type: "send_text_to_user",
                chatId,
                text: `Bound to existing session <code>${matchedSessionId}</code>.`,
                options: { parse_mode: "HTML", message_thread_id: Number(threadId) },
            }],
        }
    }

    // No matching session — tell the user to use /new or /refresh
    dbg("FORUM-CREATED", `no session match for topic "${topicTitle}", prompting user`)
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
        effects: [{
            type: "send_text_to_user",
            chatId,
            text: `Topic created but no session named "${topicTitle}" found. Use /new ${topicTitle} to start a session, or /refresh to spawn one here.`,
            options: { message_thread_id: Number(threadId) },
        }],
    }
}
