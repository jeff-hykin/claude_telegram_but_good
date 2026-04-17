// commands/pause.js — Action-returning hot commands (pause + resume).
//
// Deno.kill stays inline — it's an in-process syscall, not a
// subprocess spawn, and has no effect-layer analogue. State mutation
// flows through stateChanges.

import { versionedImport } from "../lib/version.js"
const { loadAccess } = await versionedImport("../lib/access.js", import.meta)
const { dbg } = await versionedImport("../lib/logging.js", import.meta)

export const tips = [
    "/pause suspends the whole claude process — it won't use resources until you /resume.",
]

export const descriptions = {
    pause: "Suspend the focused session (SIGTSTP)",
    resume: "Resume a paused session (SIGCONT)",
}

function reply(chatId, text) {
    return { effects: [{ type: "send_text_to_user", chatId, text }] }
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
        const focused = findSessionForEvent(event, core, "PAUSE")
        if (!focused) { return reply(event.chatId, "No focused session.") }

        if (focused.paused) {
            return reply(event.chatId, "Session is already paused. Use /resume to continue.")
        }

        try {
            Deno.kill(focused.pid, "SIGTSTP")
        } catch (err) {
            return reply(event.chatId, `Pause failed: ${err instanceof Error ? err.message : err}`)
        }
        return {
            stateChanges: {
                chatSessions: { [focused.id]: { paused: true } },
            },
            effects: [
                {
                    type: "send_text_to_user",
                    chatId: event.chatId,
                    text: `Paused session ${focused.id} (PID ${focused.pid})`,
                },
            ],
        }
    },

    resume: (event, core) => {
        if (!gate(event)) { return { effects: [] } }
        const focused = findSessionForEvent(event, core, "RESUME")
        if (!focused) { return reply(event.chatId, "No focused session.") }

        if (!focused.paused) {
            return reply(event.chatId, "Session is not paused.")
        }

        try {
            Deno.kill(focused.pid, "SIGCONT")
        } catch (err) {
            return reply(event.chatId, `Resume failed: ${err instanceof Error ? err.message : err}`)
        }
        return {
            stateChanges: {
                chatSessions: { [focused.id]: { paused: false } },
            },
            effects: [
                {
                    type: "send_text_to_user",
                    chatId: event.chatId,
                    text: `Resumed session ${focused.id} (PID ${focused.pid})`,
                },
            ],
        }
    },
}
