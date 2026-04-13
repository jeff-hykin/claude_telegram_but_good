// ---------------------------------------------------------------------------
// lib/long-task-actions.js — shared builders for long-task state changes.
//
// The handlers in lib/event-handlers/chat-user.js and the hot command
// in commands/cancel.js both need to produce the same "cancel this
// long task" Action, so the builder lives here. Pure: reads core,
// returns { stateChanges, effects } — no side effects, no I/O.
//
// Cancelling a task MARKS it state="cancelled" and leaves the entry in
// specialData so /task_resume_<id> can find it again. The worker's
// longTaskId pointer is cleared (so the session is free to host
// another task) and the pendingNudgeAction flips to "none" so the
// Stop hook's taskCheck branch stops firing.
// ---------------------------------------------------------------------------

import { versionedImport } from "./version.js"

const { dbg } = await versionedImport("./logging.js", import.meta)
const { escapeHtml: esc } = await versionedImport("./pure/html.js", import.meta)

/**
 * Render the user-facing helper-command list for a task id. Shared
 * between /task creation, /task_status replies, and the rejection
 * message when a session already owns a task — every surface should
 * show the same four actions.
 */
export function taskCommandLinks(taskId) {
    return [
        `/task_status_${taskId} — check status`,
        `/task_view_${taskId} — view definition of done`,
        `/task_update_${taskId} — modify the definition`,
        `/task_cancel_${taskId} — cancel the task`,
    ].join("\n")
}

/**
 * Build a cancel Action for a given task.
 *
 * Returns `{ ok: true, action }` on success or `{ ok: false, reason }`
 * if the task isn't cancellable (not found, already in a terminal state).
 * The reason string is suitable for a user-facing reply.
 */
export function buildCancelAction(core, chatId, taskId) {
    const task = core?.specialData?.longTaskByChatId?.[chatId]?.[taskId]
    if (!task) {
        return { ok: false, reason: `Task <code>${esc(taskId)}</code> not found.` }
    }
    if (task.state === "cancelled") {
        return { ok: false, reason: `Task <code>${esc(taskId)}</code> is already cancelled. Use <code>/task_resume_${esc(taskId)}</code> to resume.` }
    }
    if (task.state === "certified" || task.state === "escalated") {
        return { ok: false, reason: `Task <code>${esc(taskId)}</code> is in terminal state <code>${esc(task.state)}</code> and cannot be cancelled.` }
    }

    dbg("LONG-TASK", `cancelling ${taskId}`)

    const workerSessionId = task.workerSessionId
    const effects = [
        {
            type: "send_text_to_user",
            chatId,
            text:
                `Task <code>${esc(taskId)}</code> cancelled. ` +
                `Use <code>/task_resume_${esc(taskId)}</code> to resume.`,
            options: { parse_mode: "HTML" },
        },
        {
            type: "cold_append",
            stream: "long-tasks",
            entry: {
                event: "cancelled",
                taskId,
                chatId,
                sessionId: workerSessionId,
            },
        },
    ]
    if (workerSessionId) {
        effects.push({
            type: "deliver_channel_event",
            sessionId: workerSessionId,
            content:
                `[long task ${taskId} — cancelled]\n` +
                `The user has cancelled this task. Stop working on it.`,
            meta: {},
        })
    }

    // Record the pre-cancel state so /task_resume_<id> knows where to
    // put it back. Leaves `definition` and `workerSessionId` in place
    // so the resume path has enough to reconstitute the task.
    const prevState = task.state ?? "defining"
    const stateChanges = {
        specialData: {
            longTaskByChatId: {
                [chatId]: {
                    [taskId]: {
                        state: "cancelled",
                        stateBeforeCancel: prevState,
                        cancelledAt: new Date().toISOString(),
                    },
                },
            },
        },
    }
    if (workerSessionId) {
        stateChanges.chatSessions = {
            [workerSessionId]: {
                longTaskId: undefined,
                pendingNudgeAction: "none",
                status: "idle",
            },
        }
    }

    return { ok: true, action: { stateChanges, effects } }
}
