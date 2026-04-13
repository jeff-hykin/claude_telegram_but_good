// commands/start.js — Action-returning hot command.
//
// Public: anyone in a DM can run /start to see pairing instructions.
// (Allowlist gate in telegram-user.js only blocks plain text, not
// commands, so unpaired users can still reach /start / /help / /ping /
// /status / /version.)

import { versionedImport } from "../lib/version.js"
const { loadAccess } = await versionedImport("../lib/access.js", import.meta)

export const tips = []

export const descriptions = {
    start: "Welcome and pairing instructions",
}

export const commands = {
    start: (event, _core) => {
        if (event.chatType !== "private") {
            return { effects: [] }
        }
        const access = loadAccess()
        if (access.dmPolicy === "disabled") {
            return {
                effects: [
                    {
                        type: "send_text_to_user",
                        chatId: event.chatId,
                        text: "This bot isn't accepting new connections.",
                    },
                ],
            }
        }
        const userId = event.userId ?? "unknown"
        const text =
            `This bot bridges Telegram to a Claude Code session.\n\n` +
            `Your Telegram user ID: ${userId}\n\n` +
            `To pair:\n` +
            `1. DM me anything — you'll get a 6-char code\n` +
            `2. In Claude Code: /telegram:access pair <code>\n\n` +
            `After that, DMs here reach that session.`
        return {
            effects: [
                {
                    type: "send_text_to_user",
                    chatId: event.chatId,
                    text,
                },
            ],
        }
    },
}
