// commands/new_command.js — Action-returning hot command.
//
// Asks Claude to author a new custom command via the `new_command` MCP
// tool. Legacy code used `state.letClaudeHandle` to imperatively
// re-enqueue a synthetic chat_user_message; the Action-model
// equivalent is a followUpEvent with the same shape.

import { versionedImport } from "../lib/version.js"
const { loadAccess } = await versionedImport("../lib/access.js", import.meta)
const { paths } = await versionedImport("../lib/paths.js", import.meta)
const { sendEffect } = await versionedImport("../lib/pure/reply-to.js", import.meta)

export const tips = [
    "custom commands don't need to involve an agent, they're just JavaScript ( /new_command )",
    "the /new_command command lets you make your own",
    `custom telegram commands are saved in <code>${paths.CUSTOM_COMMANDS_DIR}/</code> if you want to edit them`,
]

export const descriptions = {
    new_command: "Create a new custom Telegram command",
}

export const commands = {
    new_command: (event, _core) => {
        const access = loadAccess()
        const isCC = String(event.chatId) === String(access.commandCenterChatId ?? "")
        if (event.chatType !== "private" && !isCC) { return { effects: [] } }
        if (!access.allowFrom.includes(String(event.userId ?? ""))) {
            return { effects: [] }
        }

        const text = event.text ?? ""
        const arg = text.replace(/^\/new_command\s*/, "").trim()
        if (!arg) {
            return {
                effects: [
                    sendEffect(event.replyTo, "Usage: /new_command <description of what the command should do>"),
                ],
            }
        }

        // Forward to the focused session as a synthetic plain-text
        // message. The dispatcher in chat-user.js will pick it up
        // off the event queue on the next iteration, route it to the
        // focused session's worker, and start a spinner — same flow a
        // real plain-text DM would take. The command files shipped
        // with CBG now return Actions, so the instructions describe
        // the NEW contract (not the legacy (ctx, bot, state) API).
        const instruction =
            `Please make a new telegram command by using the new_command MCP tool you have access to.\n\n` +
            `Commands are JavaScript files with this shape (Action-returning contract):\n\n` +
            `    export const tips = []  // optional, string[]\n` +
            `    export const descriptions = { foo: "short description" }\n\n` +
            `    export const commands = {\n` +
            `        foo: async (event, core) => ({\n` +
            `            stateChanges: {}, // optional — patches for chatState/chatSessions/specialData\n` +
            `            effects: [        // e.g. { type: "send_text_to_user", chatId, text, options }\n` +
            `                { type: "send_text_to_user", chatId: event.chatId, text: "hello" },\n` +
            `            ],\n` +
            `        }),\n` +
            `    }\n\n` +
            `Available fields on \`event\`: chatId, userId, username, messageId, text, chatType, replyToMessageId.\n` +
            `\`core\` exposes: chatState, chatSessions, specialData, bot (read-only).\n\n` +
            `All Telegram messages must use parse_mode "HTML" (not Markdown). ` +
            `Use <i>, <b>, <code>, <pre> for formatting and escape user content with &amp; &lt; &gt;.\n\n` +
            `Here is the user's description of what the new command should do:\n\n${arg}`

        return {
            effects: [],
            followUpEvents: [
                {
                    type: "chat_user_message",
                    ts: Date.now(),
                    chatId: event.chatId,
                    userId: event.userId,
                    username: event.username,
                    messageId: event.messageId,
                    text: instruction,
                    replyToMessageId: null,
                    replyToText: null,
                    attachment: null,
                    chatType: event.chatType,
                    _ctx: event._ctx,
                },
            ],
        }
    },
}
