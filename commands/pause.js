// commands/pause.js — Action-returning hot commands (pause + resume).
//
// Deno.kill stays inline — it's an in-process syscall, not a
// subprocess spawn, and has no effect-layer analogue. State mutation
// flows through stateChanges.

import { versionedImport } from "../lib/version.js"
const { loadAccess } = await versionedImport("../lib/access.js", import.meta)
const { dbg } = await versionedImport("../lib/logging.js", import.meta)
const { makeReplyTo, sendEffect } = await versionedImport("../lib/pure/reply-to.js", import.meta)

export const tips = [
    "/pause suspends the whole claude process — it won't use resources until you /resume.",
]

export const descriptions = {
    pause: "Suspend the focused session (SIGTSTP)",
    resume: "Resume a paused session (SIGCONT)",
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
    pause: (event, core) => {
        if (!gate(event)) { return { effects: [] } }
        const replyTo = makeReplyTo(event, "cmd/pause")
        const focused = findSessionForEvent(event, core, "PAUSE")
        if (!focused) { return { effects: [sendEffect(replyTo, "No focused session.")] } }

        if (focused.paused) {
            return { effects: [sendEffect(replyTo, "Session is already paused. Use /resume to continue.")] }
        }

        try {
            Deno.kill(focused.pid, "SIGTSTP")
        } catch (err) {
            return { effects: [sendEffect(replyTo, `Pause failed: ${err instanceof Error ? err.message : err}`)] }
        }
        return {
            stateChanges: {
                chatSessions: { [focused.id]: { paused: true } },
            },
            effects: [sendEffect(replyTo, `Paused session ${focused.id} (PID ${focused.pid})`)],
        }
    },

    resume: (event, core) => {
        if (!gate(event)) { return { effects: [] } }
        const replyTo = makeReplyTo(event, "cmd/resume")
        const focused = findSessionForEvent(event, core, "RESUME")
        if (!focused) { return { effects: [sendEffect(replyTo, "No focused session.")] } }

        if (!focused.paused) {
            return { effects: [sendEffect(replyTo, "Session is not paused.")] }
        }

        try {
            Deno.kill(focused.pid, "SIGCONT")
        } catch (err) {
            return { effects: [sendEffect(replyTo, `Resume failed: ${err instanceof Error ? err.message : err}`)] }
        }
        return {
            stateChanges: {
                chatSessions: { [focused.id]: { paused: false } },
            },
            effects: [sendEffect(replyTo, `Resumed session ${focused.id} (PID ${focused.pid})`)],
        }
    },
}
