// commands/session_slash_shortcuts.js — thin shortcuts over /raw.
//
// `/compact`, `/model <text>`, and `/goal <text>` are exact aliases for
// `/raw /compact`, `/raw /model <text>`, `/raw /goal <text>`. They stream
// the whole message verbatim into the focused session's dtach socket (as if
// typed at the terminal), press Enter, then peek 0.5s later so the user sees
// the result — same behavior as raw.js.

import { versionedImport } from "../lib/version.js"
const { dbg } = await versionedImport("../lib/logging.js", import.meta)
const { resolveCommandSession, peekTimerEffect } = await versionedImport("../lib/command-session.js", import.meta)

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
    const { action, session } = resolveCommandSession(event, core, `cmd/${cmdName}`)
    if (action) { return action }

    const text = event.text ?? ""
    dbg("SLASH-SHORTCUT", `injecting "${text}" to session ${session.id}`)
    return {
        effects: [
            { type: "send_raw_input_to_claude", sessionId: session.id, text },
            peekTimerEffect(event, cmdName),
        ],
    }
}

export const commands = {
    compact: makeShortcut("compact"),
    model: makeShortcut("model"),
    goal: makeShortcut("goal"),
}
