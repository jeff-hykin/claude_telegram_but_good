// commands/raw.js — Action-returning hot commands.
//
// Streams text straight into a session's dtach socket character-by-character
// (with a slight pause between each char) and a trailing Enter, as if it
// were typed at the attached terminal. Useful for feeding input to whatever
// program is currently running in the session — a shell, a REPL, a prompt —
// not just Claude's TUI.
//
// /raw_up, /raw_down, /raw_left, /raw_right send the corresponding arrow
// keystroke instead: one atomic write, no Enter.

import { versionedImport } from "../lib/version.js"
const { dbg } = await versionedImport("../lib/logging.js", import.meta)
const { resolveCommandSession, peekTimerEffect } = await versionedImport("../lib/command-session.js", import.meta)

export const tips = [
    "/raw <text> types text into the focused session char-by-char, then presses Enter.",
    "/raw feeds input to whatever program is attached — a shell, a REPL, a prompt — not just Claude.",
    "/raw_up, /raw_down, /raw_left, /raw_right press arrow keys — handy for picking from a TUI menu.",
]

export const descriptions = {
    raw: "Type text into a session's terminal char-by-char, then Enter",
    raw_up: "Press the up arrow key in a session's terminal",
    raw_down: "Press the down arrow key in a session's terminal",
    raw_left: "Press the left arrow key in a session's terminal",
    raw_right: "Press the right arrow key in a session's terminal",
}

// The bytes a terminal emulator sends for the arrow keys in normal
// (non-application) cursor mode.
const ARROW_KEYS = {
    raw_up: "\x1b[A",
    raw_down: "\x1b[B",
    raw_right: "\x1b[C",
    raw_left: "\x1b[D",
}

const makeArrowCommand = (cmdName) => (event, core) => {
    const { action, session } = resolveCommandSession(event, core, `cmd/${cmdName}`)
    if (action) { return action }

    dbg("RAW", `sending ${cmdName} to session ${session.id}`)
    return {
        effects: [
            // atomic: an arrow key is an escape SEQUENCE — split across
            // reads, the lone ESC reads as the Escape key instead.
            { type: "send_raw_input_to_claude", sessionId: session.id, text: ARROW_KEYS[cmdName], submit: false, atomic: true },
            peekTimerEffect(event, cmdName),
        ],
    }
}

export const commands = {
    raw: (event, core) => {
        const { action, session } = resolveCommandSession(event, core, "cmd/raw")
        if (action) { return action }

        // Everything after the command name is the literal text to inject.
        // Preserve it verbatim — no trimming of internal whitespace. With no
        // argument the text is empty, which just sends the trailing Enter.
        const text = (event.text ?? "").replace(/^\/raw\s?/, "")

        dbg("RAW", `injecting ${text.length} chars to session ${session.id}`)
        return {
            effects: [
                { type: "send_raw_input_to_claude", sessionId: session.id, text },
                peekTimerEffect(event, "raw"),
            ],
        }
    },
    raw_up: makeArrowCommand("raw_up"),
    raw_down: makeArrowCommand("raw_down"),
    raw_left: makeArrowCommand("raw_left"),
    raw_right: makeArrowCommand("raw_right"),
}
