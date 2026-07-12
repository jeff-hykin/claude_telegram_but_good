// commands/session_slash_shortcuts.js — thin shortcuts over /raw_input.
//
// `/compact`, `/model <text>`, and `/goal <text>` are exact aliases for
// `/raw_input /compact`, `/raw_input /model <text>`, `/raw_input /goal <text>`.
// They stream the whole message verbatim into the focused session's dtach
// socket (as if typed at the terminal), press Enter, then peek 0.5s later so
// the user sees the result — same behavior as raw_input.js.

import { versionedImport } from "../lib/version.js"
const { loadAccess } = await versionedImport("../lib/access.js", import.meta)
const { dbg } = await versionedImport("../lib/logging.js", import.meta)
const { replyToFromEvent, sendEffect } = await versionedImport("../lib/pure/reply-to.js", import.meta)

export const tips = [
    "/compact tells the focused session's Claude to compact its context.",
    "/model <name> switches the focused session's Claude model (e.g. /model sonnet).",
    "/goal <text> runs the focused session's /goal slash command.",
]

export const descriptions = {
    compact: "Run /compact in the focused session's Claude",
    model: "Run /model <text> in the focused session's Claude",
    goal: "Run /goal <text> in the focused session's Claude",
}

// Builds a command handler that injects the message verbatim into the focused
// session — the message already starts with the slash command we want to run.
const makeShortcut = (cmdName) => (event, core) => {
    const access = loadAccess()
    const isCommandCenter = String(event.chatId) === String(access.commandCenterChatId ?? "")
    if (event.chatType !== "private" && !isCommandCenter) { return { effects: [] } }
    if (!isCommandCenter && !access.allowFrom.includes(String(event.userId ?? ""))) {
        return { effects: [] }
    }

    const replyTo = replyToFromEvent(event, `cmd/${cmdName}`)

    // Inject the whole message verbatim (e.g. "/model sonnet") — it IS the
    // slash command Claude should run.
    const text = event.text ?? ""

    // Resolve the target session: explicit CC topic mapping first, then the
    // focused session, then any session as a last resort.
    const sessionsMap = core.chatSessions ?? {}
    const sessions = Object.values(sessionsMap)
    let session = null
    if (isCommandCenter && event.threadId) {
        const cc = core.chatState?.commandCenter ?? {}
        const mappedSession = cc.threadMap?.[String(event.threadId)]
        if (mappedSession) {
            session = sessions.find(s => s.id === mappedSession)
        }
    }
    if (!session) {
        const focusedId = core.chatState?.focusedSessionId
        if (focusedId) {
            session = sessions.find(s => s.id === focusedId)
        }
    }
    if (!session && sessions.length > 0) {
        session = sessions[0]
    }
    if (!session) { return { effects: [sendEffect(replyTo, "No active sessions.")] } }
    if (!session.dtachSocket) {
        return { effects: [sendEffect(replyTo, `Session "${session.id}" has no dtach socket — can't inject input.`)] }
    }

    dbg("SLASH-SHORTCUT", `injecting "${text}" to session ${session.id}`)

    // After the input lands, wait 0.5s then peek so the user sees the result.
    const peekEvent = {
        type: "chat_user_message",
        chatId: event.chatId,
        threadId: event.threadId ?? null,
        chatType: event.chatType,
        userId: event.userId,
        username: event.username ?? null,
        messageId: `${cmdName}_peek_${Date.now()}`,
        text: "/peek",
        ts: Date.now(),
    }
    return {
        effects: [
            { type: "send_raw_input_to_claude", sessionId: session.id, text },
            { type: "set_timer", delayMs: 500, event: peekEvent },
        ],
    }
}

export const commands = {
    compact: makeShortcut("compact"),
    model: makeShortcut("model"),
    goal: makeShortcut("goal"),
}
