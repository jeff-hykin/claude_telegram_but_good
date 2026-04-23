// ---------------------------------------------------------------------------
// lib/pure/reply-to.js
//
// The replyTo object is the canonical routing address for every outbound
// Telegram message. It answers one question: "where does this go?"
//
// Two fields, no coupling to session state:
//   { chatId: String, threadId: Number | null }
//
// Created from inbound events via makeReplyTo(), or derived from
// session state via replyToForSession() for system-originated messages.
// ---------------------------------------------------------------------------

/**
 * Create a replyTo from an inbound event (chat_user_message).
 * @param {{ chatId: string|number, threadId?: string|number|null }} event
 * @param {string} [setBy] — who created this replyTo (for tracing)
 * @returns {{ chatId: string, threadId: number|null, setBy: string|null }}
 */
export function makeReplyTo(event, setBy) {
    return {
        chatId: String(event.chatId),
        threadId: event.threadId != null ? Number(event.threadId) : null,
        setBy: setBy ?? null,
    }
}

/**
 * Derive a replyTo for a session from its command center topic binding.
 * Used by system-originated handlers (hook-stop, critic-verdict, etc.)
 * that don't have an inbound user event.
 *
 * @param {string} sessionId
 * @param {object} core — the core state object
 * @param {object} access — loadAccess() result
 * @param {string} [setBy] — who created this replyTo (for tracing)
 * @returns {{ chatId: string, threadId: number|null, setBy: string|null } | null}
 */
export function replyToForSession(sessionId, core, access, setBy) {
    const cc = core.chatState?.commandCenter ?? {}
    const threadId = cc.topicMap?.[sessionId] ?? null
    const chatId = access.commandCenterChatId ?? access.allowFrom?.[0] ?? null
    if (!chatId) { return null }
    return {
        chatId: String(chatId),
        threadId: threadId != null ? Number(threadId) : null,
        setBy: setBy ?? null,
    }
}

/**
 * Build a send_text_to_user effect from a replyTo object.
 * @param {{ chatId: string, threadId: number|null }} replyTo
 * @param {string} text
 * @param {object} [extraOptions] — additional options (parse_mode, etc.)
 * @returns {object} — a send_text_to_user effect
 */
export function sendEffect(replyTo, text, extraOptions) {
    const options = { ...(extraOptions ?? {}) }
    if (replyTo.threadId != null) {
        options.message_thread_id = replyTo.threadId
    }
    return {
        type: "send_text_to_user",
        chatId: replyTo.chatId,
        text,
        options,
    }
}

/**
 * Build a send_file_to_user effect from a replyTo object.
 * @param {{ chatId: string, threadId: number|null }} replyTo
 * @param {string} filePath
 * @param {object} [extraOptions]
 * @returns {object}
 */
export function sendFileEffect(replyTo, filePath, extraOptions) {
    const options = { ...(extraOptions ?? {}) }
    if (replyTo.threadId != null) {
        options.message_thread_id = replyTo.threadId
    }
    return {
        type: "send_file_to_user",
        chatId: replyTo.chatId,
        filePath,
        options,
    }
}
