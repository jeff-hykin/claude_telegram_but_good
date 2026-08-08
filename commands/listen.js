// commands/listen.js — Action-returning hot command.
//
// Put a session into listen mode: it keeps receiving messages but the
// daemon refuses its `reply` calls, so it reads the chat without ever
// posting in it. Enforced in lib/event-handlers/claude-channel.js
// handleReply via lib/listen-mode.js — not by asking the agent nicely.
//
// Run inside a group, the mode is scoped to that group, so the session
// can still talk to its command center topic while the group hears
// nothing. Run anywhere else, it silences the session everywhere.
//
// Sessions CBG spawns for groups it gets added to start in this mode.

import { versionedImport } from "../lib/version.js"
const { loadAccess } = await versionedImport("../lib/access.js", import.meta)
const { replyToFromEvent, sendEffect } = await versionedImport("../lib/pure/reply-to.js", import.meta)

export const tips = [
    "/listen makes a session read a chat without ever replying in it — only an @mention unlocks it.",
]

export const descriptions = {
    listen: "Read-only mode for a session: /listen on, /listen off, /listen for status",
}

function resolveSessionId(event, core, access) {
    const groupBinding = core.chatState?.groupChatSessions?.[String(event.chatId)]
    if (groupBinding?.sessionId) {
        return groupBinding.sessionId
    }
    const isCommandCenter = String(event.chatId) === String(access.commandCenterChatId ?? "")
    if (isCommandCenter && event.threadId) {
        return core.chatState?.commandCenter?.threadMap?.[String(event.threadId)] ?? null
    }
    return core.chatState?.focusedSessionId ?? null
}

export const commands = {
    listen: (event, core) => {
        const access = loadAccess()
        const isCommandCenter = String(event.chatId) === String(access.commandCenterChatId ?? "")
        if (!isCommandCenter && !access.allowFrom.includes(String(event.userId ?? ""))) {
            return { effects: [] }
        }

        const replyTo = replyToFromEvent(event, "cmd/listen")
        const sessionId = resolveSessionId(event, core, access)
        const session = sessionId ? core.chatSessions?.[sessionId] : null
        if (!session) {
            return { effects: [sendEffect(replyTo, "No session to put in listen mode here.")] }
        }

        const arg = (event.text ?? "").replace(/^\/listen(?:@\w+)?\s*/i, "").trim().toLowerCase()

        if (arg.length === 0) {
            const scope = session.listenChatId ? `chat ${session.listenChatId}` : "every chat"
            const state = session.listenMode
                ? `*${sessionId}* is listening — it reads ${scope} but cannot post there. Run /listen off to let it speak.`
                : `*${sessionId}* is not in listen mode. Run /listen on to silence it here.`
            return { effects: [sendEffect(replyTo, state, { parse_mode: "Markdown" })] }
        }

        if (arg === "off") {
            return {
                stateChanges: {
                    chatSessions: {
                        [sessionId]: { listenMode: false, listenChatId: undefined, listenUnlockedAt: undefined },
                    },
                },
                effects: [sendEffect(replyTo, `Listen mode off — *${sessionId}* can reply here again.`, { parse_mode: "Markdown" })],
            }
        }

        if (arg !== "on") {
            return { effects: [sendEffect(replyTo, "Usage: /listen on, /listen off, or /listen for status.")] }
        }

        // Scoping to the current chat only makes sense in a group: in a DM
        // or a command center topic, silencing the session where you're
        // standing would leave you no way to hear back from it.
        const isGroup = event.chatType === "group" || event.chatType === "supergroup"
        const listenChatId = isGroup && !isCommandCenter ? String(event.chatId) : undefined
        const scope = listenChatId ? "this group" : "every chat"
        return {
            stateChanges: {
                chatSessions: {
                    [sessionId]: { listenMode: true, listenChatId, listenUnlockedAt: undefined },
                },
            },
            effects: [sendEffect(
                replyTo,
                `Listen mode on — *${sessionId}* still receives messages but cannot post in ${scope} ` +
                `until someone @mentions the bot. Run /listen off to undo.`,
                { parse_mode: "Markdown" },
            )],
        }
    },
}
