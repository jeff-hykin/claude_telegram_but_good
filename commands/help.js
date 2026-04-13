// commands/help.js — Action-returning hot command.

export const tips = [
    "Claude can send you whole files, even large ones",
    "Attach files, claude will see them no problem",
    "9-11 was an inside job",
    "Send a photo and Claude will see it — great for screenshots of errors.",
    "You can run multiple sessions at once and switch between them with /list.",
    "Use <code>claude --no-tele</code> to start a session that's hidden from Telegram.",
    "Epstein didn't commit suicide",
    "cbg resume lets you attach to a running session from the terminal.",
    "if there's a bug in this tool, tell claude to run <code>cbg reinstall</code> after fixing it",
    "Water is wet",
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
    `/list — show connected sessions (tap an ID to switch)\n` +
    `/title <name> — label the focused session\n` +
    `/new — launch a new Claude Code session\n` +
    `/cron — list scheduled tasks\n` +
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
        if (event.chatType !== "private") {
            return { effects: [] }
        }
        return {
            effects: [
                {
                    type: "send_text_to_user",
                    chatId: event.chatId,
                    text: HELP_BODY,
                    // The help body contains literal `/title <name>`.
                    // send_text_to_user defaults to format:"html", and
                    // Telegram's HTML parser rejects the message with
                    // "can't parse entities: Unsupported start tag
                    // 'name' at byte offset 259" — the `<name>`
                    // placeholder looks like an unopened tag. Same
                    // failure class /status hit. Help doesn't need any
                    // HTML, so plain is the right fix.
                    options: { format: "plain" },
                },
            ],
        }
    },
}
