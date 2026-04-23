// ---------------------------------------------------------------------------
// task_checkin handler.
//
// Fired by a 30-minute timer as a backup nudge for long tasks. Ensures
// the worker checks in on progress even when it's running long builds
// or tests that don't produce Stop hooks.
//
// The timer is scheduled when a task enters in_progress and reset on:
//   - user messages to the session
//   - report.md submission (critic spawned)
//   - any other nudge
// Cancelled when the task completes or is cancelled.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { paths } = await versionedImport("../paths.js", import.meta)

const TASK_CHECKIN_MS = 30 * 60 * 1000

const CHECKIN_NUDGE_TEXT = `[automated check-in] It's been 30 minutes since your last check-in. Please briefly report your progress — what you've done, what's running, and what's next. If you're done, write report.md.`

function findChatIdForTask(core, taskId) {
    const byChat = core.specialData?.longTaskByChatId ?? {}
    for (const [chatId, tasks] of Object.entries(byChat)) {
        if (tasks?.[taskId] !== undefined) { return chatId }
    }
    return null
}

export default function handle(event, core) {
    const { sessionId, taskId } = event
    if (!sessionId || !taskId) {
        dbg("TASK-CHECKIN", "invalid event — missing sessionId or taskId")
        return null
    }

    const session = core.chatSessions?.[sessionId]
    if (!session) {
        dbg("TASK-CHECKIN", `session ${sessionId} gone — skipping`)
        return null
    }

    // Only fire if the session still owns this task and it's in_progress.
    if (session.longTaskId !== taskId) {
        dbg("TASK-CHECKIN", `session ${sessionId} no longer owns ${taskId} — skipping`)
        return null
    }

    const chatId = findChatIdForTask(core, taskId)
    const task = chatId ? core.specialData?.longTaskByChatId?.[chatId]?.[taskId] : null
    if (!task || task.state !== "in_progress") {
        dbg("TASK-CHECKIN", `task ${taskId} not in_progress (state=${task?.state}) — skipping`)
        return null
    }

    // Check if report.md already exists — if so, no need to nudge.
    try {
        Deno.statSync(paths.longTaskDir(taskId) + "/report.md")
        dbg("TASK-CHECKIN", `report.md exists for ${taskId} — skipping check-in`)
        return null
    } catch {
        // No report — proceed with check-in nudge.
    }

    dbg("TASK-CHECKIN", `30min check-in nudge for ${taskId} on ${sessionId}`)

    return {
        stateChanges: {},
        effects: [
            {
                type: "send_text_to_claude",
                sessionId,
                text: CHECKIN_NUDGE_TEXT,
            },
            // Reschedule the next check-in.
            {
                type: "set_timer",
                delayMs: TASK_CHECKIN_MS,
                event: { type: "task_checkin", sessionId, taskId },
            },
        ],
    }
}
