// lib/event-handlers/long-task-rehydrate.js
//
// One-shot event enqueued by main-server.js at startup for each
// in_progress long task. Re-arms the task_checkin timer.
//
// Why this exists: the 30-minute task_checkin is the restart-independent
// backup nudge chain, but it rides on an in-memory set_timer (no
// persistence). A daemon restart wipes every pending set_timer, so the
// check-in chain silently dies and the worker stops being nudged — a
// long task can then stall for hours unseen. Scheduled tasks and interval
// hooks already rehydrate their timers on startup; long tasks did not.
// This closes that gap. The worker session's longTaskId /
// pendingNudgeAction survive in persisted chatSessions state (restored on
// shim reconnect), so re-arming this single timer is enough to revive the
// whole nudge watchdog: task_checkin re-validates the session at fire time
// and self-reschedules.

import { versionedImport } from "../version.js"
const { dbg } = await versionedImport("../logging.js", import.meta)

const TASK_CHECKIN_MS = 30 * 60 * 1000

export default function handle(event, _core) {
    const { taskId, workerSessionId } = event
    if (!taskId || !workerSessionId) {
        dbg("LONG-TASK-REHYDRATE", `missing fields: ${JSON.stringify({ taskId, workerSessionId })}`)
        return null
    }
    dbg("LONG-TASK-REHYDRATE", `re-arming check-in timer for ${taskId} on ${workerSessionId}`)
    return {
        effects: [
            {
                type: "set_timer",
                delayMs: TASK_CHECKIN_MS,
                event: { type: "task_checkin", sessionId: workerSessionId, taskId },
            },
        ],
    }
}
