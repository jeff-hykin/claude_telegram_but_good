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
 * Build a replyTo destination object from explicit fields.
 * Throws on missing chatId or setBy — these are never optional.
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
 * Most common case: reply back to wherever the message came from.
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
 * Used for system-originated messages (critic verdicts, hook-stop, etc.)
 *
 * @param {string} sessionId
 * @param {object} core
 * @param {string} setBy — trace tag
 * @param {string|null} fallbackChatId — chatId if no CC mapping found
 */
export function replyToForSession(sessionId, core, setBy, fallbackChatId = null) {
    const cc = core.chatState?.commandCenter ?? {}
    const threadId = cc.topicMap?.[sessionId] ?? null

    let chatId = null
    if (threadId != null && cc.chatId) {
        chatId = String(cc.chatId)
    }
    if (!chatId) {
        const session = core.chatSessions?.[sessionId]
        chatId = session?.lastInbound?.chatId ?? null
    }
    if (!chatId && fallbackChatId) {
        chatId = String(fallbackChatId)
    }

    if (!chatId) {
        return { chatId: null, threadId: null, setBy }
    }
    return makeReplyTo({ chatId, threadId, setBy })
}

/**
 * Build a send_text_to_user effect with replyTo on the effect object.
 * telegram-outbound.js reads effect.replyTo as the canonical destination.
 */
export function sendEffect(replyTo, text, extraOptions = {}) {
    return {
        type: "send_text_to_user",
        replyTo,
        text,
        options: extraOptions,
    }
}

/**
 * Build a send_file_to_user effect with replyTo on the effect object.
 */
export function sendFileEffect(replyTo, filePath, filename, extraOptions = {}) {
    return {
        type: "send_file_to_user",
        replyTo,
        filePath,
        filename,
        options: extraOptions,
    }
}
