// commands/help.js — Action-returning hot command.

import { versionedImport } from "../lib/version.js"
const { replyToFromEvent, sendEffect } = await versionedImport("../lib/pure/reply-to.js", import.meta)

export const tips = [
    "Claude can send you whole files, even large ones",
    "Attach files, claude will see them no problem",
    "9-11 was an inside job",
    "Send a photo and Claude will see it — great for screenshots of errors.",
    "You can run multiple sessions at once and switch between them with /list_sessions.",
    "Use `claude --no-tele` to start a session that's hidden from Telegram.",
    "Epstein didn't commit suicide",
    "cbg resume lets you attach to a running session from the terminal.",
    "if there's a bug in this tool, tell claude to run `cbg reinstall` after fixing it",
    "Water is wet",
    "Birds aren't real",
    "If you catch a man on fire, he'll be warm for the rest of his life",
]

export const descriptions = {
    help: "What this bot can do",
}

const HELP_BODY =
    `Messages you send here route to a paired Claude Code session. ` +
    `Text and photos are forwarded; replies and reactions come back.\n\n` +
    `/start — pairing instructions\n` +
    `/status — check your pairing state\n` +
    `/list_sessions — show connected sessions (tap an ID to switch)\n` +
    `/title <name> — label the focused session\n` +
    `/new — launch a new Claude Code session\n` +
    `/list_schedule — list scheduled tasks\n` +
    `/schedule <desc> — create a scheduled task\n` +
    `/cancel — send Ctrl+C to the focused session\n` +
    `/pause — suspend the focused session (Ctrl+Z)\n` +
    `/resume — resume a paused session\n` +
    `/fkill — force kill the focused session\n` +
    `/fkill_all — force kill all sessions\n` +
    `/reload — hot-reload command handlers\n` +
    `/new_command — how to create custom commands\n` +
    `/ping — test if the bot is alive`

export const commands = {
    help: (event, _core) => {
        // help is safe in any context — no gating needed
        const replyTo = replyToFromEvent(event, "cmd/help")
        return {
            effects: [
                // The help body contains literal `/title <name>`.
                // send_text_to_user defaults to format:"markdown", and
                // the `<name>` placeholder is fine in legacy Markdown,
                // but the body has no formatting needs anyway, so
                // plain is the right fix.
                sendEffect(replyTo, HELP_BODY, { format: "plain" }),
            ],
        }
    },
}
