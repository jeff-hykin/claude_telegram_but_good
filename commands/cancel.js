// commands/cancel.js — Action-returning hot command.
//
// Two-mode cancel:
//
//   1. Focused session has a long task → cancel the long task (marks
//      it state="cancelled", clears session.longTaskId, notifies the
//      worker via channel event). Recoverable via /task_resume_<id>.
//
//   2. Otherwise → send ESC to the focused Claude Code TUI by piping
//      0x1b into `dtach -p <sock>`. Claude Code's TUI handles ESC as
//      "cancel the current request" — the model stops, any in-flight
//      tool call is interrupted, and the session stays alive for the
//      next prompt.
//
// For mode 2 we intentionally do NOT send SIGINT to the claude process
// as a fallback: SIGINT at the OS level is "kill/crash the process",
// which is bigger than "stop the current request" and leaves dtach
// holding a dead child. If a session has no dtach socket we'd rather
// report the problem than pretend to cancel by killing. (Per CLAUDE.md:
// "All sessions must run under dtach" — no socket means something is
// wrong upstream and the user needs to know.)
//
// The dtach call stays inline — there's no effect-layer dtach helper
// today and this is the only caller.

import { $ } from "../imports.js"
import { versionedImport } from "../lib/version.js"
const { loadAccess } = await versionedImport("../lib/access.js", import.meta)
const { dbg } = await versionedImport("../lib/logging.js", import.meta)
const { buildCancelAction } = await versionedImport("../lib/long-task-actions.js", import.meta)

export const tips = [
    "/cancel will stop the current request",
]

export const descriptions = {
    cancel: "Stop the current request in the focused session",
}

// How long to wait for `dtach -p` to accept the ESC byte and exit.
// dtach's -p is usually instantaneous — it only blocks if the socket
// is gone or wedged. Three seconds is plenty of headroom without
// leaving the cancel command hanging indefinitely on a dead socket.
const DTACH_WRITE_TIMEOUT_MS = 3000

function reply(chatId, text) {
    return { effects: [{ type: "send_text_to_user", chatId, text }] }
}

export const commands = {
    cancel: async (event, core) => {
        if (event.chatType !== "private") { return { effects: [] } }
        const access = loadAccess()
        if (!access.allowFrom.includes(String(event.userId ?? ""))) {
            return { effects: [] }
        }

        const focusedId = core.chatState?.focusedSessionId
        const focused = focusedId ? core.chatSessions?.[focusedId] : null
        if (!focused) { return reply(event.chatId, "No focused session.") }

        // Mode 1: long-task cancel. Takes priority over ESC-to-dtach so
        // a running task gets its full cleanup path (cold-storage entry,
        // worker notification, stateBeforeCancel marker for resume).
        // ESC alone would only interrupt claude's current turn — the
        // task pointer and nudge watchdog state would stay set.
        const longTaskId = focused.longTaskId
        if (longTaskId) {
            dbg("CANCEL", `focused session ${focused.id} owns ${longTaskId} — delegating to buildCancelAction`)
            const result = buildCancelAction(core, event.chatId, longTaskId)
            if (result.ok) {
                return result.action
            }
            // Task pointer pointed at something un-cancellable (already
            // cancelled / missing / terminal). Surface the reason and
            // fall through to the ESC path below so the user still gets
            // some effect from their /cancel.
            dbg("CANCEL", `buildCancelAction rejected: ${result.reason}`)
        }

        // Mode 2: plain ESC-to-dtach. No active long task, just stop
        // whatever claude is currently doing.
        if (!focused.dtachSocket) {
            // Fail loud instead of SIGINT-ing the process. A session
            // without a dtach socket is an invariant violation — the
            // user should know something's wrong upstream.
            return reply(
                event.chatId,
                `Session ${focused.id} has no dtach socket; can't cancel. ` +
                `This usually means the session was spawned outside the cbg ` +
                `shim wrapper. Restart it via /new or the cbg CLI.`,
            )
        }

        try {
            // Pipe ESC (0x1b) into dtach -p — dax quotes the socket
            // path as a single argv entry, no shell injection.
            await $`dtach -p ${focused.dtachSocket}`
                .stdinText("\x1b")
                .timeout(DTACH_WRITE_TIMEOUT_MS)
            return reply(event.chatId, `Sent Escape to session ${focused.id} via dtach`)
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            dbg("CANCEL", "failed:", msg)
            return reply(event.chatId, `Cancel failed: ${msg}`)
        }
    },
}
