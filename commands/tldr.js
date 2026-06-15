// commands/tldr.js — Action-returning hot command.
//
// Toggle a max-length on agent replies. `/tldr <N>` makes any reply whose
// text is longer than N characters get rejected before it's sent — the agent
// is instantly told "Make your message more concise" and retries shorter
// (enforced in lib/event-handlers/claude-channel.js handleReply). `/tldr`
// with no number turns the mode off (any length allowed).
//
// The limit lives at chatState.tldrMaxChars (global; survives reloads).

import { versionedImport } from "../lib/version.js"
const { loadAccess } = await versionedImport("../lib/access.js", import.meta)
const { replyToFromEvent, sendEffect } = await versionedImport("../lib/pure/reply-to.js", import.meta)

export const tips = [
    "/tldr 1000 rejects any agent reply over 1000 chars and makes it retry shorter.",
    "/tldr with no number turns the length limit off.",
]

export const descriptions = {
    tldr: "Toggle a max length on agent replies (/tldr 1000, or /tldr to turn off)",
}

export const commands = {
    tldr: (event, core) => {
        const access = loadAccess()
        const isCommandCenter = String(event.chatId) === String(access.commandCenterChatId ?? "")
        if (event.chatType !== "private" && !isCommandCenter) { return { effects: [] } }
        if (!isCommandCenter && !access.allowFrom.includes(String(event.userId ?? ""))) {
            return { effects: [] }
        }

        const replyTo = replyToFromEvent(event, "cmd/tldr")
        const arg = (event.text ?? "").replace(/^\/tldr\s*/, "").trim()

        // No argument → turn the mode off.
        if (arg.length === 0) {
            return {
                stateChanges: { chatState: { tldrMaxChars: undefined } },
                effects: [sendEffect(replyTo, "TLDR mode off — agent replies can be any length.")],
            }
        }

        // Argument must be a positive integer char count.
        if (!/^\d+$/.test(arg)) {
            return {
                effects: [sendEffect(replyTo, "Usage: /tldr <number> to set a max char count, or /tldr (no number) to turn it off.")],
            }
        }
        const limit = parseInt(arg, 10)
        if (limit <= 0) {
            return {
                effects: [sendEffect(replyTo, "Give a positive number, e.g. /tldr 1000. Use /tldr with no number to turn it off.")],
            }
        }

        return {
            stateChanges: { chatState: { tldrMaxChars: limit } },
            effects: [sendEffect(replyTo, `TLDR mode on — agent replies over ${limit} chars will be rejected and asked to shorten. Run /tldr to turn off.`)],
        }
    },
}
