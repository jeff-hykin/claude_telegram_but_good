// commands/allow.js — manage the allowlist from Telegram.
//
// The allowlist is what decides whose words ever reach an agent: a
// sender who is not on it is dropped in a DM and in a group chat alike.
// Editing it used to mean running the `/telegram:access` skill from an
// assistant session or hand-editing access.json, neither of which is
// available from a phone.
//
// Only someone already on the allowlist may add to it — including in the
// command center, which otherwise trusts everyone in the room. Handing
// out access is the one thing where "you are in the group" is not enough.

import { versionedImport } from "../lib/version.js"
const { loadAccess } = await versionedImport("../lib/access.js", import.meta)
const { dbg } = await versionedImport("../lib/logging.js", import.meta)
const { escapeMarkdown: esc } = await versionedImport("../lib/pure/markdown.js", import.meta)
const { replyToFromEvent, sendEffect } = await versionedImport("../lib/pure/reply-to.js", import.meta)

export const descriptions = {
    allow: "Add someone to the allowlist (id, pairing code, or reply to them)",
}

export const tips = [
    "/allow — who can reach the bot, plus any pairing codes waiting.",
    "Reply to someone's message with /allow to let them in without hunting for their user id.",
    "/allow remove <id> takes someone back off the list.",
]

const PAIRING_CODE = /^[0-9a-f]{6}$/i

function formatList(access) {
    const lines = []
    const allowed = access.allowFrom ?? []
    lines.push(allowed.length > 0
        ? `*Allowed senders:*\n${allowed.map(id => `• \`${esc(String(id))}\``).join("\n")}`
        : "*Allowed senders:* nobody yet.")

    const pending = Object.entries(access.pending ?? {})
    if (pending.length > 0) {
        lines.push("")
        lines.push("*Waiting to be paired:*")
        for (const [code, p] of pending) {
            lines.push(`• \`${esc(code)}\` — user \`${esc(String(p.senderId))}\` (\`/allow ${esc(code)}\`)`)
        }
    }
    lines.push("")
    lines.push("Add someone: reply to one of their messages with `/allow`, or `/allow <user id>`, or `/allow <pairing code>`. Remove: `/allow remove <id>`.")
    return lines.join("\n")
}

export const commands = {
    allow: (event, _core) => {
        const access = loadAccess()
        const senderId = String(event.userId ?? "")
        const replyTo = replyToFromEvent(event, "cmd/allow")
        const md = { parse_mode: "Markdown" }

        // Deliberately stricter than every other command: membership of
        // the command center does NOT grant this.
        if (!(access.allowFrom ?? []).includes(senderId)) {
            dbg("ALLOW", `refused: ${senderId} is not on the allowlist`)
            return { effects: [] }
        }

        const arg = (event.text ?? "").replace(/^\/allow(?:@\w+)?\s*/i, "").trim()

        // Reply to someone's message: the sender of that message is who
        // we are being asked about, which saves hunting for a numeric id.
        const repliedTo = event._ctx?.message?.reply_to_message?.from
        if (arg.length === 0 && repliedTo) {
            if (repliedTo.is_bot) {
                return { effects: [sendEffect(replyTo, "That's a bot's message — reply to a person's message instead.", md)] }
            }
            const id = String(repliedTo.id)
            if ((access.allowFrom ?? []).includes(id)) {
                return { effects: [sendEffect(replyTo, `\`${esc(id)}\` is already on the allowlist.`, md)] }
            }
            const who = repliedTo.username ? `@${repliedTo.username}` : (repliedTo.first_name ?? id)
            return {
                effects: [
                    { type: "update_allowlist", add: [id] },
                    sendEffect(replyTo, `Added ${esc(who)} (\`${esc(id)}\`) to the allowlist.`, md),
                ],
            }
        }

        if (arg.length === 0) {
            return { effects: [sendEffect(replyTo, formatList(access), md)] }
        }

        const removeMatch = arg.match(/^(?:remove|rm|del|delete)\s+(\S+)$/i)
        if (removeMatch) {
            const id = removeMatch[1]
            if (!(access.allowFrom ?? []).includes(id)) {
                return { effects: [sendEffect(replyTo, `\`${esc(id)}\` is not on the allowlist.`, md)] }
            }
            if (id === senderId) {
                return { effects: [sendEffect(replyTo, "That's you — removing yourself would lock you out. Edit `access.json` by hand if you really mean it.", md)] }
            }
            return {
                effects: [
                    { type: "update_allowlist", remove: [id] },
                    sendEffect(replyTo, `Removed \`${esc(id)}\` from the allowlist.`, md),
                ],
            }
        }

        // A pairing code from someone who DM'd the bot and was asked to
        // wait. Approving it tells them so, in the chat they wrote from.
        const pending = access.pending ?? {}
        if (PAIRING_CODE.test(arg) && pending[arg.toLowerCase()]) {
            const code = arg.toLowerCase()
            const entry = pending[code]
            const effects = [
                { type: "update_allowlist", add: [String(entry.senderId)], clearPending: [code] },
                sendEffect(replyTo, `Paired \`${esc(code)}\` — user \`${esc(String(entry.senderId))}\` can now reach the bot.`, md),
            ]
            if (entry.chatId) {
                effects.push({
                    type: "send_text_to_user",
                    chatId: String(entry.chatId),
                    text: "You're approved — go ahead and send a message.",
                })
            }
            return { effects }
        }

        if (/^\d+$/.test(arg)) {
            if ((access.allowFrom ?? []).includes(arg)) {
                return { effects: [sendEffect(replyTo, `\`${esc(arg)}\` is already on the allowlist.`, md)] }
            }
            return {
                effects: [
                    { type: "update_allowlist", add: [arg] },
                    sendEffect(replyTo, `Added \`${esc(arg)}\` to the allowlist.`, md),
                ],
            }
        }

        // A @username is not resolvable: Telegram gives bots numeric ids
        // only, and a username is never carried on a message we can look
        // up later. Say so rather than failing vaguely.
        if (arg.startsWith("@")) {
            return { effects: [sendEffect(replyTo, "Telegram doesn't let a bot look up a username. Reply to one of their messages with `/allow`, or have them DM the bot and approve the pairing code it gives them.", md)] }
        }

        return { effects: [sendEffect(replyTo, `Not a user id or a live pairing code: \`${esc(arg)}\`.\n\n${formatList(access)}`, md)] }
    },
}
