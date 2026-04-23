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
const { replyToFromEvent, sendEffect } = await versionedImport("../lib/pure/reply-to.js", import.meta)

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
        const replyTo = replyToFromEvent(event, "cmd/kill")
        const focused = findSessionForEvent(event, core, "KILL")
        if (!focused) { return { effects: [sendEffect(replyTo, "No focused session.")] } }
        try {
            Deno.kill(focused.pid, "SIGINT")
            return { effects: [sendEffect(replyTo, `Sent SIGINT to Claude Code (PID ${focused.pid})`)] }
        } catch (err) {
            return { effects: [sendEffect(replyTo, `kill failed: ${err instanceof Error ? err.message : err}`)] }
        }
    },

    fkill: (event, core) => {
        if (!gate(event)) { return { effects: [] } }
        const replyTo = replyToFromEvent(event, "cmd/fkill")
        const focused = findSessionForEvent(event, core, "FKILL")
        if (!focused) { return { effects: [sendEffect(replyTo, "No focused session.")] } }
        try {
            Deno.kill(focused.pid, "SIGTERM")
            return { effects: [sendEffect(replyTo, `Sent SIGTERM to Claude Code (PID ${focused.pid})`)] }
        } catch (err) {
            return { effects: [sendEffect(replyTo, `fkill failed: ${err instanceof Error ? err.message : err}`)] }
        }
    },

    relay_shutdown: (event, _core) => {
        if (!gate(event)) { return { effects: [] } }
        const replyTo = replyToFromEvent(event, "cmd/relay_shutdown")
        // Fire the confirmation reply and schedule the exit: we need
        // the event loop to drain the outbound effect before we kill
        // the process, so the user actually sees the message.
        setTimeout(() => Deno.exit(0), 200)
        return { effects: [sendEffect(replyTo, "Telegram relay shut down. Claude sessions are still running.")] }
    },

    fkill_all: (event, core) => {
        if (!gate(event)) { return { effects: [] } }
        const replyTo = replyToFromEvent(event, "cmd/fkill_all")
        const sessions = Object.values(core.chatSessions ?? {})
        for (const s of sessions) {
            try { Deno.kill(s.pid, "SIGKILL") } catch (e) { /* best-effort */ }
        }
        return { effects: [sendEffect(replyTo, "Killing all Claude sessions.")] }
    },
}
