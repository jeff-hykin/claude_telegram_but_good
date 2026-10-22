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
// Sessions CBG spawns for groups it gets added to do NOT start in this
// mode — a group's members are allowlisted, so the bot answers them
// like any other member until `/listen on` is run inside the group.

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

        // In a group the setting belongs to the GROUP, not to whichever
        // session happens to be serving it: it lives on the binding, so a
        // replacement session doesn't come back muzzled (or come back
        // talking, if it was told to be quiet). The binding is then the
        // ONLY copy — see the note in chat-user's group handler about why
        // a second one on the session would just lie.
        const binding = core.chatState?.groupChatSessions?.[String(event.chatId)]
        const groupKey = binding ? String(event.chatId) : null
        const listening = groupKey ? binding.listenMode === true : session.listenMode === true

        if (arg.length === 0) {
            const scope = groupKey ? `this group` : (session.listenChatId ? `chat ${session.listenChatId}` : "every chat")
            const state = listening
                ? `*${sessionId}* is listening — it reads ${scope} but cannot post there until someone @mentions the bot. ` +
                    `Run /listen off to let it answer every message.`
                : `*${sessionId}* is not in listen mode — it answers every message it is given. Run /listen on to silence it here.`
            return { effects: [sendEffect(replyTo, state, { parse_mode: "Markdown" })] }
        }

        const bindingPatch = (listenMode) => groupKey
            ? { chatState: { groupChatSessions: { [groupKey]: { listenMode } } } }
            : {}
        // In a group the session-level flag is deleted rather than set:
        // the binding decides, and a stale second copy is worse than none.
        const sessionFlag = (listenMode, listenChatId) => groupKey
            ? { listenMode: undefined, listenChatId: groupKey, listenUnlockedAt: undefined }
            : { listenMode, listenChatId, listenUnlockedAt: undefined }

        if (arg === "off") {
            return {
                stateChanges: {
                    ...bindingPatch(false),
                    chatSessions: { [sessionId]: sessionFlag(false, undefined) },
                },
                effects: [sendEffect(
                    replyTo,
                    groupKey
                        ? `Listen mode off — *${sessionId}* now answers every message here, @mention or not. ` +
                            `The setting sticks if the session is replaced. Run /listen on to go quiet again.`
                        : `Listen mode off — *${sessionId}* can reply here again.`,
                    { parse_mode: "Markdown" },
                )],
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
                ...bindingPatch(true),
                chatSessions: { [sessionId]: sessionFlag(true, listenChatId) },
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
