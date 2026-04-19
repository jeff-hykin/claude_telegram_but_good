// commands/set_command_center.js — Action-returning hot command.
//
// Designates the current group as the "command center" — a forum-enabled
// supergroup where each topic maps to a Claude session. Anyone in the
// group gets full access to the bot and the machine it runs on.

import { versionedImport } from "../lib/version.js"
const { loadAccess, saveAccess, readAccessFile } = await versionedImport("../lib/access.js", import.meta)
const { dbg } = await versionedImport("../lib/logging.js", import.meta)
const { replyToFromEvent } = await versionedImport("../lib/pure/reply-to.js", import.meta)

export const descriptions = {
    set_command_center: "Designate this group as the command center",
}

function reply(replyTo, text) {
    return { effects: [{ type: "send_text_to_user", replyTo, text, options: { parse_mode: "HTML" } }] }
}

export const commands = {
    set_command_center: async (event, core) => {
        const replyTo = event._replyTo ?? replyToFromEvent(event, "cmd:set_command_center")
        const chatType = event.chatType
        if (chatType !== "supergroup") {
            return reply(replyTo, "This command must be sent in a supergroup with Topics enabled.")
        }

        // Check if bot has admin rights by trying to get chat info
        // (Grammy context is on _ctx)
        const ctx = event._ctx
        let chatInfo
        try {
            chatInfo = await ctx.api.getChat(event.chatId)
        } catch (e) {
            dbg("SET-CMD-CENTER", "getChat failed:", e)
            return reply(replyTo, "Could not verify group settings. Make sure I have admin rights.")
        }

        // Verify forum mode is enabled
        if (!chatInfo.is_forum) {
            return reply(replyTo, "This group needs Topics enabled. Go to group settings → Topics → toggle on, then try again.")
        }

        // Check bot is admin
        let botMember
        try {
            const botInfo = await ctx.api.getMe()
            botMember = await ctx.api.getChatMember(event.chatId, botInfo.id)
        } catch (e) {
            dbg("SET-CMD-CENTER", "getChatMember failed:", e)
            return reply(replyTo, "Could not verify my admin status. Please promote me to admin and try again.")
        }

        if (botMember.status !== "administrator" && botMember.status !== "creator") {
            return reply(replyTo, "I need admin rights to manage topics. Please promote me to admin and try again.")
        }

        // Save to access.json
        const access = readAccessFile()
        access.commandCenterChatId = String(event.chatId)
        // Also add to groups if not already there
        if (!access.groups[String(event.chatId)]) {
            access.groups[String(event.chatId)] = {
                requireMention: false,
                allowFrom: [],
            }
        }
        saveAccess(access)

        // Initialize command center state
        const cc = core.chatState?.commandCenter ?? {}
        const topicMap = { ...(cc.topicMap ?? {}) }
        const threadMap = { ...(cc.threadMap ?? {}) }

        // Scan existing sessions and create topics for ones with titles
        const effects = []
        const sessions = core.chatSessions ?? {}
        for (const [sid, sess] of Object.entries(sessions)) {
            if (!sess?.title || topicMap[sid]) { continue }
            effects.push({
                type: "create_thread",
                chatId: String(event.chatId),
                title: sess.title,
                sessionId: sid,
            })
        }

        // Security warning
        effects.unshift({
            type: "send_text_to_user",
            replyTo,
            text: `⚠️ <b>Command Center activated.</b>\n\nAnyone in this group will have total control over the bot and the computer it runs on.\n\nUse /revoke_command_center to disable this at any time.`,
            options: { parse_mode: "HTML" },
        })

        return {
            stateChanges: {
                chatState: {
                    commandCenter: {
                        chatId: String(event.chatId),
                        outputMode: "both",
                        topicMap,
                        threadMap,
                    },
                },
            },
            effects,
        }
    },
}
