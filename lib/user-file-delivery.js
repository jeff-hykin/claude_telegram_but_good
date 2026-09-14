// lib/user-file-delivery.js — SendUserFile, delivered to the chat the
// user is actually reading.
//
// SendUserFile is Claude Code's own tool. In a cbg session the "user" it
// sends to is not the Telegram chat driving the session, so the files
// land somewhere nobody is looking — and it answers "N files delivered
// to user", which reads exactly like proof that they arrived. Three
// deliveries were lost to that before this existed; the tool's own
// description ("use this for any file the user would want to see") wins
// against any note telling an agent to avoid it.
//
// So the call is intercepted at PreToolUse: cbg sends the files itself,
// through the same effect `reply` uses, and the tool is denied with a
// reason saying the delivery already happened. Denying rather than
// allowing is deliberate — an allowed call would ALSO report its own
// phantom success, which is the thing that burned people.

import { versionedImport } from "./version.js"

const { dbg } = await versionedImport("./logging.js", import.meta)
const { loadAccess } = await versionedImport("./access.js", import.meta)
const { listenBlockReason } = await versionedImport("./listen-mode.js", import.meta)

/**
 * Where this session's files should go: the topic it is bound to, the
 * group it listens to, or the last chat that wrote to it.
 */
export function resolveFileTarget(sessionId, core) {
    const session = core.chatSessions?.[sessionId]
    if (!session) { return null }

    const cc = core.chatState?.commandCenter ?? {}
    const threadId = cc.topicMap?.[sessionId] ?? null
    const ccChatId = loadAccess().commandCenterChatId
    if (threadId && ccChatId) {
        return { chatId: String(ccChatId), threadId: Number(threadId) }
    }
    if (session.listenChatId) {
        return { chatId: String(session.listenChatId), threadId: null }
    }
    const lastChat = session.lastInbound?.chatId
    if (lastChat) {
        return { chatId: String(lastChat), threadId: null }
    }
    return null
}

/**
 * Turn one SendUserFile call into the effects that actually deliver it,
 * plus the reason the tool is told it was denied.
 *
 * @returns {{effects: object[], reason: string}}
 */
export function planUserFileDelivery(event, core) {
    const sessionId = event.sessionId
    const input = event.toolInput ?? {}
    const files = Array.isArray(input.files)
        ? input.files.filter(f => typeof f === "string" && f.length > 0)
        : []
    const caption = typeof input.caption === "string" ? input.caption : ""

    if (files.length === 0) {
        return {
            effects: [],
            reason: "SendUserFile does not reach this session's chat — use the `reply` tool with `chat_id` and `files` instead. (No file paths were given, so nothing was sent.)",
        }
    }

    // A session listening to someone else's group must not post into it,
    // and that includes attachments. Same rule the reply tool enforces.
    const listenReason = listenBlockReason(core.chatSessions?.[sessionId], core.chatSessions?.[sessionId]?.listenChatId)
    if (listenReason) {
        return { effects: [], reason: `Files not sent. ${listenReason}` }
    }

    const target = resolveFileTarget(sessionId, core)
    if (!target) {
        return {
            effects: [],
            reason: "SendUserFile does not reach this session's chat, and cbg could not work out which chat to send to (this session is not bound to a topic and has no inbound message to answer). Use the `reply` tool with an explicit `chat_id` and `files`.",
        }
    }

    const options = target.threadId ? { message_thread_id: target.threadId } : undefined
    const effects = files.map((filePath, i) => ({
        type: "send_file_to_user",
        chatId: target.chatId,
        filePath,
        filename: filePath.split("/").pop() || filePath,
        // Caption on the first file only, exactly like a multi-file
        // reply — repeating it under every attachment is noise.
        caption: i === 0 && caption ? caption : undefined,
        options,
        recordAs: {
            from: "agent",
            kind: "regular",
            sessionId: sessionId ?? null,
            text: caption.slice(0, 500),
            ts: event.ts ?? Date.now(),
        },
    }))

    dbg("USER-FILE", `${sessionId}: re-routing ${files.length} file(s) to chat ${target.chatId}${target.threadId ? ` thread ${target.threadId}` : ""}`)

    const names = files.map(f => f.split("/").pop()).join(", ")
    return {
        effects,
        reason:
            `SendUserFile does not reach this session's chat — cbg has already delivered ${files.length === 1 ? "the file" : `all ${files.length} files`} (${names}) to the user's Telegram topic on your behalf, with your caption. ` +
            "Do NOT send them again. For future files, call the `reply` tool with `chat_id` and `files` — that is the delivery path in this session, and it reports real failures.",
    }
}
