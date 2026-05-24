// lib/event-handlers/scheduled-task-stuck-watchdog.js
//
// Periodic watchdog that detects scheduled-task runs stuck in `running`
// state past a sane threshold and synthesizes a run_complete (errored) to
// reset state and rearm the timer. Mirrors the orphan cleanup in
// main-server.js startup, but catches the daemon-stays-up case where a
// worker stalls (e.g. Claude CLI froze on an API 529 mid-run) without
// ever calling report-ready / critic-verdict.
//
// Self-schedules via set_timer every SCAN_INTERVAL_MS. The initial tick
// is enqueued from main-server.js at startup.

import { versionedImport } from "../version.js"
const { dbg } = await versionedImport("../logging.js", import.meta)

// How often to scan for stuck runs.
const SCAN_INTERVAL_MS = 5 * 60 * 1000

// Default age past which a `running` task is considered stuck. Generous
// enough that no current scheduled-task budget bumps into it. Tasks can
// opt into a tighter limit by setting `stuckThresholdMs` on the task.
const DEFAULT_STUCK_THRESHOLD_MS = 6 * 60 * 60 * 1000

export default function handle(_event, core) {
    const effects = [
        {
            type: "set_timer",
            delayMs: SCAN_INTERVAL_MS,
            event: { type: "scheduled_task_stuck_watchdog" },
        },
    ]
    const followUpEvents = []

    const byChat = core?.specialData?.scheduledTaskByChatId ?? {}
    const now = Date.now()
    let reaped = 0

    for (const [chatId, tasks] of Object.entries(byChat)) {
        for (const [scheduleTaskId, task] of Object.entries(tasks ?? {})) {
            if (!task || typeof task !== "object") { continue }
            if (task.state !== "running") { continue }
            const startedAt = task.currentRun?.startedAt
            if (!startedAt) { continue }
            const startedMs = Date.parse(startedAt)
            if (Number.isNaN(startedMs)) { continue }
            const ageMs = now - startedMs
            const threshold = task.stuckThresholdMs ?? DEFAULT_STUCK_THRESHOLD_MS
            if (ageMs < threshold) { continue }

            const ageMin = Math.round(ageMs / 60_000)
            const thresholdMin = Math.round(threshold / 60_000)
            dbg("SCHED-WATCHDOG", `${scheduleTaskId} stuck for ${ageMin}min (threshold ${thresholdMin}min) — reaping`)

            if (task.currentRun.runIso) {
                effects.push({
                    type: "scheduled_task_worker_kill",
                    scheduleTaskId,
                    runIso: task.currentRun.runIso,
                })
            }

            followUpEvents.push({
                type: "scheduled_task_run_complete",
                chatId,
                scheduleTaskId,
                runIso: task.currentRun.runIso,
                status: "errored",
                summary: `Watchdog reaped run after ${ageMin}min (threshold ${thresholdMin}min). ` +
                    `Worker stalled without writing report.md — check the dtach.log in the run dir.`,
            })
            reaped++
        }
    }

    if (reaped > 0) {
        dbg("SCHED-WATCHDOG", `reaped ${reaped} stuck run(s) this tick`)
    }

    return { effects, followUpEvents }
}
