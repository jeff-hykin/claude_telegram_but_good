// ---------------------------------------------------------------------------
// lib/pure/reply-to.js — replyTo object factory.
//
// Every outbound Telegram message MUST carry a replyTo that says where
// it goes. No defaults, no fallbacks — if replyTo is missing, it's a bug.
//
// Shape: { chatId: String, threadId: Number|null, setBy: String }
//   - chatId:   Telegram chat to send to
//   - threadId: forum topic thread ID (null for DMs or General)
//   - setBy:    who created this replyTo (for debugging routing issues)
// ---------------------------------------------------------------------------

/**
 * Create a replyTo from an inbound user event.
 * Used by chat-user.js at the top of handle() — stamps the event
 * so all downstream code knows where to reply.
 */
export function makeReplyTo(event, setBy = "chat-user") {
    return {
        chatId: String(event.chatId),
        threadId: event.threadId != null ? Number(event.threadId) : null,
        setBy,
    }
}

/**
 * Create a replyTo for a session — derives the destination from
 * the command center topicMap. Used by system-originating messages
 * (critic verdicts, hook-stop nudges, orphan warnings) that don't
 * have an inbound event to derive from.
 *
 * @param {string} sessionId
 * @param {{ chatState, chatSessions }} core
 * @param {string} setBy — who is creating this replyTo
 * @param {string|null} fallbackChatId — chatId to use if no CC mapping
 */
export function replyToForSession(sessionId, core, setBy = "system", fallbackChatId = null) {
    const cc = core.chatState?.commandCenter ?? {}
    const threadId = cc.topicMap?.[sessionId] ?? null

    // Prefer the command center chatId if the session is bound to a topic.
    let chatId = null
    if (threadId != null && cc.chatId) {
        chatId = String(cc.chatId)
    }

    // Fall back to the session's last known inbound chatId.
    if (!chatId) {
        const session = core.chatSessions?.[sessionId]
        chatId = session?.lastInbound?.chatId ?? null
    }

    // Last resort: caller-provided fallback.
    if (!chatId && fallbackChatId) {
        chatId = String(fallbackChatId)
    }

    return {
        chatId: chatId ? String(chatId) : null,
        threadId: threadId != null ? Number(threadId) : null,
        setBy,
    }
}

/**
 * Convert a replyTo into Telegram send options.
 * Merges with any existing options object.
 */
export function replyToOptions(replyTo, extraOptions = {}) {
    const options = { ...extraOptions }
    if (replyTo?.threadId != null) {
        options.message_thread_id = Number(replyTo.threadId)
    }
    return options
}

/**
 * Build a send_text_to_user effect from a replyTo.
 */
export function sendEffect(replyTo, text, extraOptions = {}) {
    return {
        type: "send_text_to_user",
        chatId: replyTo.chatId,
        text,
        options: replyToOptions(replyTo, extraOptions),
    }
}

/**
 * Build a send_file_to_user effect from a replyTo.
 */
export function sendFileEffect(replyTo, filePath, filename, extraOptions = {}) {
    return {
        type: "send_file_to_user",
        chatId: replyTo.chatId,
        filePath,
        filename,
        options: replyToOptions(replyTo, extraOptions),
    }
}
