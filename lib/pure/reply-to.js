// ---------------------------------------------------------------------------
// lib/pure/reply-to.js — replyTo destination objects.
//
// Every outbound Telegram effect (send_text_to_user, send_file_to_user)
// MUST carry a `replyTo` object that describes WHERE the message goes
// and WHO decided that destination. No defaults, no fallbacks — if an
// effect is missing replyTo, something upstream failed to set it.
//
// Shape:
//   { chatId: String, threadId: Number|null, setBy: String }
//
// `setBy` is a human-readable trace tag so we can grep logs to find
// exactly which code path decided the destination for any given message.
// ---------------------------------------------------------------------------

/**
 * Build a replyTo destination object.
 *
 * @param {object} opts
 * @param {string|number} opts.chatId   — target chat
 * @param {number|string|null} [opts.threadId]  — forum topic thread (null for DMs / General)
 * @param {string} opts.setBy           — trace tag: who created this replyTo
 * @returns {{ chatId: string, threadId: number|null, setBy: string }}
 */
export function makeReplyTo({ chatId, threadId = null, setBy }) {
    if (chatId == null) {
        throw new Error(`makeReplyTo: chatId is required (setBy=${setBy})`)
    }
    if (!setBy) {
        throw new Error(`makeReplyTo: setBy is required (chatId=${chatId})`)
    }
    return {
        chatId: String(chatId),
        threadId: threadId != null ? Number(threadId) : null,
        setBy,
    }
}

/**
 * Build a replyTo from an inbound user-message event.
 *
 * This is the most common case: a user sent a message and we want to
 * reply back to wherever it came from (same chat, same topic thread).
 *
 * @param {object} event — must have chatId, may have threadId
 * @param {string} setBy — trace tag
 * @returns {{ chatId: string, threadId: number|null, setBy: string }}
 */
export function replyToFromEvent(event, setBy) {
    return makeReplyTo({
        chatId: event.chatId,
        threadId: event.threadId ?? null,
        setBy,
    })
}

/**
 * Build a replyTo targeting a session's command center topic.
 *
 * Used for system-originated messages (critic verdicts, hook-stop
 * notifications, etc.) that need to reach the right topic thread
 * for a given session.
 *
 * Returns null if the session has no command center binding.
 *
 * @param {string} sessionId
 * @param {object} core
 * @param {string} setBy — trace tag
 * @returns {{ chatId: string, threadId: number|null, setBy: string }|null}
 */
export function replyToForSession(sessionId, core, setBy) {
    const cc = core.chatState?.commandCenter ?? {}
    const ccChatId = cc.chatId
    if (!ccChatId) {
        return null
    }
    const threadId = cc.topicMap?.[sessionId] ?? null
    return makeReplyTo({
        chatId: ccChatId,
        threadId: threadId != null ? Number(threadId) : null,
        setBy,
    })
}
