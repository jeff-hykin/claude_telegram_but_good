// lib/event-handlers/stale-state-reaper.js
//
// Hourly sweep that keeps /list_sessions and /list_tasks short. Nothing else
// ever drops a session whose process died or a cancelled/escalated task, so
// both lists only grew.
//
//   - Sessions with no live connection, idle past SESSION_MAX_IDLE_MS → removed
//     (the same patch a clean unregister applies).
//   - Cancelled / escalated tasks past TASK_MAX_IDLE_MS → removed; the event is
//     cold-appended so history survives.
//   - Defining / in-progress tasks whose worker is gone, idle past
//     TASK_MAX_IDLE_MS → cancelled, so they stay resumable for one more window.
//
// Files (dtach sockets/logs, long-task dirs) are removed by the
// `reap_stale_files` effect, which does the IO and liveness probes.
//
// Self-schedules via set_timer. The first tick is enqueued from main-server.js.

import { versionedImport } from "../version.js"
const { dbg } = await versionedImport("../logging.js", import.meta)
const { buildRemoveSessionPatch } = await versionedImport("../pure/session-removal.js", import.meta)
const { mergeSessionData } = await versionedImport("../pure/state-merge.js", import.meta)

const DAY_MS = 24 * 60 * 60 * 1000
const SCAN_INTERVAL_MS = 60 * 60 * 1000
const STARTUP_DELAY_MS = 10 * 60 * 1000
const SESSION_MAX_IDLE_MS = 7 * DAY_MS
const TASK_MAX_IDLE_MS = 14 * DAY_MS
const TASK_DIR_MAX_AGE_MS = 30 * DAY_MS

function toMs(value) {
    if (typeof value === "number") { return value }
    if (typeof value === "string") {
        const ms = Date.parse(value)
        return Number.isNaN(ms) ? 0 : ms
    }
    return 0
}

function latestMs(...values) {
    return Math.max(0, ...values.map(toMs))
}

export default function handle(event, core) {
    // The startup tick only arms the timer: right after a restart no shim has
    // reconnected yet, so every session would look disconnected.
    if (event?.startup) {
        return { effects: [{ type: "set_timer", delayMs: STARTUP_DELAY_MS, event: { type: "stale_state_reaper" } }] }
    }
    const now = Date.now()
    const effects = [{ type: "set_timer", delayMs: SCAN_INTERVAL_MS, event: { type: "stale_state_reaper" } }]
    const sessions = core?.chatSessions ?? {}

    const removedSessionIds = []
    let chatStatePatch = {}
    for (const [sessionId, session] of Object.entries(sessions)) {
        if (!session || session._conn) { continue }
        const lastSeen = latestMs(session.lastActive, session.lastStopAt, session.lastOutboundAt, session.disconnectedAt, session.connectedAt)
        if (now - lastSeen < SESSION_MAX_IDLE_MS) { continue }
        removedSessionIds.push(sessionId)
        const patch = buildRemoveSessionPatch(sessionId, core)
        if (patch.chatState) {
            chatStatePatch = mergeSessionData(chatStatePatch, patch.chatState)
        }
    }

    const taskPatch = {}
    const keptTaskIds = []
    let droppedTasks = 0
    let cancelledTasks = 0
    for (const [chatId, tasks] of Object.entries(core?.specialData?.longTaskByChatId ?? {})) {
        for (const [taskId, task] of Object.entries(tasks ?? {})) {
            if (!task || typeof task !== "object") { continue }
            const lastActivity = latestMs(task.createdAt, task.lastCheckinAt, task.lastNudgeAt, task.cancelledAt, task.criticLastCallAt)
            const idle = now - lastActivity >= TASK_MAX_IDLE_MS
            if (idle && (task.state === "cancelled" || task.state === "escalated")) {
                taskPatch[chatId] = { ...(taskPatch[chatId] ?? {}), [taskId]: undefined }
                effects.push({
                    type: "cold_append",
                    stream: "long-tasks",
                    entry: { event: "reaped", taskId, chatId, state: task.state, title: task.title ?? null },
                })
                droppedTasks++
                continue
            }
            keptTaskIds.push(taskId)
            const worker = task.workerSessionId ? sessions[task.workerSessionId] : null
            if (idle && (task.state === "in_progress" || task.state === "defining") && !worker?._conn) {
                taskPatch[chatId] = {
                    ...(taskPatch[chatId] ?? {}),
                    [taskId]: {
                        state: "cancelled",
                        stateBeforeCancel: task.state,
                        cancelledAt: new Date(now).toISOString(),
                        cancelReason: "reaped: no worker for 14 days",
                    },
                }
                cancelledTasks++
            }
        }
    }

    const keptSessionIds = Object.keys(sessions).filter(id => !removedSessionIds.includes(id))
    effects.push({
        type: "reap_stale_files",
        keptSessionIds,
        keptTaskIds,
        dtachMaxAgeMs: SESSION_MAX_IDLE_MS,
        taskDirMaxAgeMs: TASK_DIR_MAX_AGE_MS,
    })

    if (removedSessionIds.length || droppedTasks || cancelledTasks) {
        dbg("REAPER", `removed ${removedSessionIds.length} session(s), dropped ${droppedTasks} task(s), cancelled ${cancelledTasks} orphaned task(s)`)
    }

    const stateChanges = {}
    if (removedSessionIds.length) {
        stateChanges.chatSessions = Object.fromEntries(removedSessionIds.map(id => [id, undefined]))
    }
    if (Object.keys(chatStatePatch).length) {
        stateChanges.chatState = chatStatePatch
    }
    if (Object.keys(taskPatch).length) {
        stateChanges.specialData = { longTaskByChatId: taskPatch }
    }
    return { stateChanges, effects }
}
