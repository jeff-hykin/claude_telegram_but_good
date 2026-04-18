// commands/kill.js — Action-returning hot commands (kill / fkill /
// fkill_all / relay_shutdown).
//
// Signals stay inline via Deno.kill (node:process.kill in the old code
// was a compat quirk). relay_shutdown calls Deno.exit directly because
// emitting an effect would require the effect dispatcher to return
// first, but the server is closing down — there's no safe alternative.

import { versionedImport } from "../lib/version.js"
const { loadAccess } = await versionedImport("../lib/access.js", import.meta)
const { dbg } = await versionedImport("../lib/logging.js", import.meta)

export const tips = [
    "/kill asks claude to stop, /fkill doesn't ask",
    "if you ever want a nuclear option, try /fkill_all",
]

export const descriptions = {
    kill: "Ask the focused session to stop (SIGINT)",
    fkill: "Force kill the focused session (SIGTERM)",
    fkill_all: "Force kill all Claude sessions",
    relay_shutdown: "Shut down the Telegram relay (sessions keep running)",
}

function reply(chatId, text, threadId) {
    const options = {}
    if (threadId != null) { options.message_thread_id = Number(threadId) }
    return { effects: [{ type: "send_text_to_user", chatId, text, options }] }
}

function findSessionForEvent(event, core, label = "CMD") {
    const access = loadAccess()
    const isCC = String(event.chatId) === String(access.commandCenterChatId ?? "")
    if (isCC && event.threadId) {
        const cc = core.chatState?.commandCenter ?? {}
        const sid = cc.threadMap?.[String(event.threadId)]
        if (sid) {
            dbg(label, `CC topic ${event.threadId} → session ${sid}`)
            return core.chatSessions?.[sid] ?? null
        }
        dbg(label, `CC topic ${event.threadId} has no mapped session`)
    }
    const focusedId = core.chatState?.focusedSessionId
    return focusedId ? core.chatSessions?.[focusedId] : null
}

function gate(event) {
    const access = loadAccess()
    const isCC = String(event.chatId) === String(access.commandCenterChatId ?? "")
    if (event.chatType !== "private" && !isCC) { return false }
    if (!isCC && !access.allowFrom.includes(String(event.userId ?? ""))) { return false }
    return true
}

export const commands = {
    kill: (event, core) => {
        if (!gate(event)) { return { effects: [] } }
        const focused = findSessionForEvent(event, core, "KILL")
        if (!focused) { return reply(event.chatId, "No focused session.", event.threadId) }
        try {
            Deno.kill(focused.pid, "SIGINT")
            return reply(event.chatId, `Sent SIGINT to Claude Code (PID ${focused.pid})`, event.threadId)
        } catch (err) {
            return reply(event.chatId, `kill failed: ${err instanceof Error ? err.message : err}`, event.threadId)
        }
    },

    fkill: (event, core) => {
        if (!gate(event)) { return { effects: [] } }
        const focused = findSessionForEvent(event, core, "FKILL")
        if (!focused) { return reply(event.chatId, "No focused session.", event.threadId) }
        try {
            Deno.kill(focused.pid, "SIGTERM")
            return reply(event.chatId, `Sent SIGTERM to Claude Code (PID ${focused.pid})`, event.threadId)
        } catch (err) {
            return reply(event.chatId, `fkill failed: ${err instanceof Error ? err.message : err}`, event.threadId)
        }
    },

    relay_shutdown: (event, _core) => {
        if (!gate(event)) { return { effects: [] } }
        // Fire the confirmation reply and schedule the exit: we need
        // the event loop to drain the outbound effect before we kill
        // the process, so the user actually sees the message.
        setTimeout(() => Deno.exit(0), 200)
        return reply(event.chatId, "Telegram relay shut down. Claude sessions are still running.", event.threadId)
    },

    fkill_all: (event, core) => {
        if (!gate(event)) { return { effects: [] } }
        const sessions = Object.values(core.chatSessions ?? {})
        for (const s of sessions) {
            try { Deno.kill(s.pid, "SIGKILL") } catch (e) { /* best-effort */ }
        }
        return reply(event.chatId, "Killing all Claude sessions.", event.threadId)
    },
}
