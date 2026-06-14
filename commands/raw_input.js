// commands/raw_input.js — Action-returning hot command.
//
// Streams text straight into a session's dtach socket character-by-character
// (with a slight pause between each char) and a trailing newline, as if it
// were typed at the attached terminal. Useful for feeding input to whatever
// program is currently running in the session — a shell, a REPL, a prompt —
// not just Claude's TUI.

import { versionedImport } from "../lib/version.js"
const { loadAccess } = await versionedImport("../lib/access.js", import.meta)
const { dbg } = await versionedImport("../lib/logging.js", import.meta)
const { replyToFromEvent, sendEffect } = await versionedImport("../lib/pure/reply-to.js", import.meta)

export const tips = [
    "/raw_input <text> types text into the focused session char-by-char, then presses Enter.",
    "/raw_input feeds input to whatever program is attached — a shell, a REPL, a prompt — not just Claude.",
]

export const descriptions = {
    raw_input: "Type text into a session's terminal char-by-char, then Enter",
}

export const commands = {
    raw_input: (event, core) => {
        const access = loadAccess()
        const isCommandCenter = String(event.chatId) === String(access.commandCenterChatId ?? "")
        if (event.chatType !== "private" && !isCommandCenter) { return { effects: [] } }
        if (!isCommandCenter && !access.allowFrom.includes(String(event.userId ?? ""))) {
            return { effects: [] }
        }

        const replyTo = replyToFromEvent(event, "cmd/raw_input")

        // Everything after the command name is the literal text to inject.
        // Preserve it verbatim — no trimming of internal whitespace. With no
        // argument the text is empty, which just sends the trailing newline
        // (i.e. presses Enter).
        const text = (event.text ?? "").replace(/^\/raw_input\s?/, "")

        // Resolve the target session: explicit CC topic mapping first, then
        // the focused session, then any session as a last resort.
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

        dbg("RAW-INPUT", `injecting ${text.length} chars to session ${session.id}`)
        return {
            effects: [{ type: "send_raw_input_to_claude", sessionId: session.id, text }],
        }
    },
}
