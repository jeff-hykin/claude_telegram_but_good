// lib/event-handlers/scheduled-task-report-ready.js
//
// The worker watcher saw report.md appear. Hand off to the critic
// via a spawn_critic effect with a `scheduledRun` target — the
// critic-subprocess's scheduled-run branch knows how to read the
// run dir and enqueue a critic_verdict event with the `scheduledRun`
// tag instead of a `taskId`.

import { versionedImport } from "../version.js"
const { findScheduledTask } = await versionedImport("../scheduled-task-actions.js", import.meta)
const { dbg } = await versionedImport("../logging.js", import.meta)

export default function handle(event, core) {
    const { chatId, scheduleTaskId, runIso } = event
    const found = findScheduledTask(core.specialData, scheduleTaskId)
    if (!found) {
        dbg("SCHED-RR", `task ${scheduleTaskId} not in state; dropping report-ready`)
        return null
    }
    dbg("SCHED-RR", `spawning critic for ${scheduleTaskId} run ${runIso}`)
    return {
        effects: [
            {
                type: "spawn_critic",
                scheduledRun: { scheduleTaskId, runIso, chatId },
                attempt: 1,
            },
        ],
    }
}
