// commands/revoke_command_center.js — Action-returning hot command.
//
// Disables command center mode. Topics stay in Telegram but the bot
// stops routing through them.

import { versionedImport } from "../lib/version.js"
const { readAccessFile, saveAccess } = await versionedImport("../lib/access.js", import.meta)
const { dbg } = await versionedImport("../lib/logging.js", import.meta)
const { replyToFromEvent } = await versionedImport("../lib/pure/reply-to.js", import.meta)

export const descriptions = {
    revoke_command_center: "Disable command center mode",
}

function reply(replyTo, text) {
    return { effects: [{ type: "send_text_to_user", replyTo, text, options: { parse_mode: "HTML" } }] }
}

export const commands = {
    revoke_command_center: async (event, _core) => {
        const access = readAccessFile()
        const ccChatId = access.commandCenterChatId

        const replyTo = event._replyTo ?? replyToFromEvent(event, "cmd:revoke_command_center")
        if (!ccChatId) {
            return reply(replyTo, "No command center is currently active.")
        }

        // Clear from access.json
        delete access.commandCenterChatId
        delete access.groups[ccChatId]
        saveAccess(access)

        dbg("REVOKE-CMD-CENTER", `command center ${ccChatId} revoked`)

        return {
            stateChanges: {
                chatState: {
                    commandCenter: undefined,
                },
            },
            effects: [{
                type: "send_text_to_user",
                replyTo,
                text: "Command center disabled. Topics remain in the group but the bot will no longer route through them.",
                options: { parse_mode: "HTML" },
            }],
        }
    },
}
