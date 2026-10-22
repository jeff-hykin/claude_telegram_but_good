/**
 * The pseudo-chat that daemon-generated events carry when no real Telegram chat
 * produced them: interval-hook notices, CLI-injected messages, touch kickoffs.
 *
 * It is NOT a Telegram chat id. Sending to it fails with "Bad Request: chat not
 * found", and the outbound fallback then redelivers the message into whatever
 * command-center topic the session happens to be bound to — which is how an
 * internal hook error turns into a message addressed to the user.
 */
export const INTERNAL_CHAT_ID = "cbg-internal"

/** True when `chatId` is the internal pseudo-chat rather than a real Telegram chat. */
export function isInternalChatId(chatId) {
    return chatId != null && String(chatId) === INTERNAL_CHAT_ID
}

/**
 * True when a reply to `chatId` can reach someone. A missing chat id is not
 * repliable: channel-event delivers it to the agent as the internal pseudo-chat.
 */
export function isRepliableChatId(chatId) {
    return chatId != null && String(chatId) !== "" && !isInternalChatId(chatId)
}
