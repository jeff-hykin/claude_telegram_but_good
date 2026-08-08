// lib/command-session.js — shared plumbing for the terminal-injection
// commands (/raw, /raw_up, /compact, /model, /goal, /login).
//
// They all need the same three things: the private-chat-or-command-center
// access gate, the CC topic → focused → first-session target resolution,
// and the 0.5s follow-up /peek so the user sees what their keystrokes did.

import { versionedImport } from "./version.js"
const { loadAccess } = await versionedImport("./access.js", import.meta)
const { replyToFromEvent, sendEffect } = await versionedImport("./pure/reply-to.js", import.meta)

/**
 * Gate the command and resolve which session's terminal it targets.
 *
 * Returns `{ action }` when the command must short-circuit (silently for a
 * disallowed sender, with a message when there's nothing to inject into),
 * or `{ session, replyTo }` when it can proceed.
 */
export function resolveCommandSession(event, core, label) {
    const access = loadAccess()
    const isCommandCenter = String(event.chatId) === String(access.commandCenterChatId ?? "")
    if (event.chatType !== "private" && !isCommandCenter) { return { action: { effects: [] } } }
    if (!isCommandCenter && !access.allowFrom.includes(String(event.userId ?? ""))) {
        return { action: { effects: [] } }
    }

    const replyTo = replyToFromEvent(event, label)
    const sessions = Object.values(core.chatSessions ?? {})
    let session = null
    if (isCommandCenter && event.threadId) {
        const mappedSession = core.chatState?.commandCenter?.threadMap?.[String(event.threadId)]
        if (mappedSession) {
            session = sessions.find((s) => s.id === mappedSession)
        }
    }
    if (!session && core.chatState?.focusedSessionId) {
        session = sessions.find((s) => s.id === core.chatState.focusedSessionId)
    }
    if (!session && sessions.length > 0) {
        session = sessions[0]
    }
    if (!session) {
        return { action: { effects: [sendEffect(replyTo, "No active sessions.")] } }
    }
    if (!session.dtachSocket) {
        return { action: { effects: [sendEffect(replyTo, `Session "${session.id}" has no dtach socket — can't inject input.`)] } }
    }
    return { session, replyTo }
}

/**
 * A `set_timer` effect that re-enters the command pipeline with a synthetic
 * "/peek" routed back to the same topic, so the terminal state shows up
 * without the user asking. /peek emits no deliver_channel_event, so this
 * can't spuriously start a spinner.
 */
export function peekTimerEffect(event, label, delayMs = 500) {
    return {
        type: "set_timer",
        delayMs,
        event: {
            type: "chat_user_message",
            chatId: event.chatId,
            threadId: event.threadId ?? null,
            chatType: event.chatType,
            userId: event.userId,
            username: event.username ?? null,
            messageId: `${label}_peek_${Date.now()}`,
            text: "/peek",
            ts: Date.now(),
        },
    }
}

/**
 * A `set_timer` effect that replays `text` as if the user had typed it in
 * this topic. Used to drive the multi-step /login sequence.
 */
export function selfMessageTimerEffect(event, text, delayMs, label) {
    return {
        type: "set_timer",
        delayMs,
        event: {
            type: "chat_user_message",
            chatId: event.chatId,
            threadId: event.threadId ?? null,
            chatType: event.chatType,
            userId: event.userId,
            username: event.username ?? null,
            messageId: `${label}_${Date.now()}`,
            text,
            ts: Date.now(),
        },
    }
}
