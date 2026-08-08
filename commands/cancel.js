// commands/cancel.js — Action-returning hot command.
//
// /cancel sends ESC to the focused Claude Code TUI by piping 0x1b into
// `dtach -p <sock>`. Claude Code's TUI handles ESC as "cancel the
// current request" — the model stops, any in-flight tool call is
// interrupted, and the session stays alive for the next prompt.
//
// /cancel intentionally does NOT cancel a focused session's active long
// task. Cancelling a long task is a bigger, harder-to-undo action, so it
// requires the explicit `/task_cancel_<id>` command instead. /cancel on
// a session that owns a long task just interrupts its current turn.
//
// A running `#`/`!`-prefix shell command in the topic is still SIGTERM'd
// by /cancel before the ESC path (shell commands have no separate cancel
// command).
//
// We intentionally do NOT send SIGINT to the claude process as a
// fallback: SIGINT at the OS level is "kill/crash the process", which is
// bigger than "stop the current request" and leaves dtach holding a dead
// child. If a session has no dtach socket we'd rather report the problem
// than pretend to cancel by killing. (Per CLAUDE.md: "All sessions must
// run under dtach" — no socket means something is wrong upstream and the
// user needs to know.)
//
// The dtach call stays inline — there's no effect-layer dtach helper
// today and this is the only caller.

import { $ } from "../imports.js"
import { versionedImport } from "../lib/version.js"
const { loadAccess } = await versionedImport("../lib/access.js", import.meta)
const { dbg } = await versionedImport("../lib/logging.js", import.meta)
const { replyToFromEvent, sendEffect } = await versionedImport("../lib/pure/reply-to.js", import.meta)
const { topicShellKey } = await versionedImport("../lib/pure/shell-cwd.js", import.meta)
const { escapeMarkdown: esc } = await versionedImport("../lib/pure/markdown.js", import.meta)

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

export const commands = {
    cancel: async (event, core) => {
        const access = loadAccess()
        const isCommandCenter = String(event.chatId) === String(access.commandCenterChatId ?? "")
        if (event.chatType !== "private" && !isCommandCenter) { return { effects: [] } }
        if (!isCommandCenter && !access.allowFrom.includes(String(event.userId ?? ""))) {
            return { effects: [] }
        }

        const replyTo = replyToFromEvent(event, "cmd/cancel")

        // Shell-command cancel: if a `#`/`!`-prefix shell command is running
        // in this topic, SIGTERM it before falling through to the
        // session-cancel paths. The shell effect's completion handler
        // posts the "[cancelled]" reply itself.
        const shellKey = topicShellKey(event.chatId, event.threadId)
        const shellEntry = core.activeShellProcs?.get(shellKey)
        if (shellEntry) {
            shellEntry.cancelled = true
            try {
                shellEntry.proc.kill("SIGTERM")
                dbg("CANCEL", `SIGTERM shell ${shellKey} pid=${shellEntry.proc.pid} cmd=${shellEntry.cmd}`)
                return { effects: [sendEffect(replyTo, `Sent SIGTERM to: \`${esc(shellEntry.cmd)}\``, { parse_mode: "Markdown" })] }
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e)
                dbg("CANCEL", `kill failed for shell ${shellKey}:`, msg)
                return { effects: [sendEffect(replyTo, `Cancel failed: ${msg}`)] }
            }
        }

        const focused = findSessionForEvent(event, core, "CANCEL")
        if (!focused) { return { effects: [sendEffect(replyTo, "No focused session.")] } }

        // ESC-to-dtach: interrupt whatever claude is currently doing. This
        // does NOT cancel a focused long task — that requires the explicit
        // /task_cancel_<id> command (see header). ESC only stops the
        // current turn; the task pointer and nudge state stay set.
        if (focused.longTaskId) {
            dbg("CANCEL", `session ${focused.id} owns ${focused.longTaskId}; /cancel only sends ESC — use /task_cancel_ to cancel the task`)
        }
        if (!focused.dtachSocket) {
            // Fail loud instead of SIGINT-ing the process. A session
            // without a dtach socket is an invariant violation — the
            // user should know something's wrong upstream.
            return {
                effects: [sendEffect(replyTo,
                    `Session ${focused.id} has no dtach socket; can't cancel. ` +
                    `This usually means the session was spawned outside the cbg ` +
                    `shim wrapper. Restart it via /new or the cbg CLI.`,
                )],
            }
        }

        // Clear any queued messages — cancelling means "stop everything".
        const queueLen = (focused.pendingQueue ?? []).length
        const queueNote = queueLen > 0 ? ` (also cleared ${queueLen} queued message(s))` : ""

        try {
            // Pipe ESC (0x1b) into dtach -p — dax quotes the socket
            // path as a single argv entry, no shell injection.
            await $`dtach -p ${focused.dtachSocket}`
                .stdinText("\x1b")
                .timeout(DTACH_WRITE_TIMEOUT_MS)
            return {
                stateChanges: {
                    chatSessions: {
                        [focused.id]: { pendingQueue: [] },
                    },
                },
                effects: [sendEffect(replyTo, `Sent Escape to session ${focused.id} via dtach${queueNote}`)],
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            dbg("CANCEL", "failed:", msg)
            return { effects: [sendEffect(replyTo, `Cancel failed: ${msg}`)] }
        }
    },
}
