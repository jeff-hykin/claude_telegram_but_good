// lib/event-handlers/scheduled-task-run-complete.js
//
// Finalize a scheduled-task run:
//   - update tracking (totalRuns, lastRunAt/Status/Summary, runHistory ring buffer)
//   - clear currentRun
//   - rearm the next fire (unless the task is cancelled)
//   - notify the user via Telegram with a short summary

import { versionedImport } from "../version.js"
const { dbg } = await versionedImport("../logging.js", import.meta)
const { findScheduledTask, scheduleCommandLinks } = await versionedImport("../scheduled-task-actions.js", import.meta)
const { escapeHtml: esc } = await versionedImport("../pure/html.js", import.meta)

const RUN_HISTORY_MAX = 10

export default function handle(event, core) {
    const { chatId, scheduleTaskId, runIso, status, summary } = event
    const found = findScheduledTask(core.specialData, scheduleTaskId)
    if (!found) {
        dbg("SCHED-DONE", `task ${scheduleTaskId} not found; swallowing run_complete`)
        return null
    }
    const { task } = found

    const prevHistory = task.tracking?.runHistory ?? []
    const newEntry = {
        runIso,
        status,
        summary: (summary ?? "").slice(0, 300),
        at: new Date().toISOString(),
    }
    const nextHistory = [...prevHistory, newEntry].slice(-RUN_HISTORY_MAX)
    const totalRuns = (task.tracking?.totalRuns ?? 0) + 1

    // If the user cancelled mid-run, don't rearm the timer or flip
    // state back to "scheduled".
    const nextState = task.state === "cancelled" ? "cancelled" : "scheduled"

    const summaryText = status === "certified"
        ? `✅ Scheduled task <code>${esc(scheduleTaskId)}</code> run certified.\n\n<pre>${esc((summary ?? "").slice(0, 1500))}</pre>\n\n${scheduleCommandLinks(scheduleTaskId)}`
        : `⚠️ Scheduled task <code>${esc(scheduleTaskId)}</code> run errored.\n\n${esc((summary ?? "").slice(0, 500))}\n\n${scheduleCommandLinks(scheduleTaskId)}`

    const effects = [
        {
            type: "send_text_to_user",
            chatId,
            text: summaryText,
            options: { parse_mode: "HTML" },
        },
        {
            type: "cold_append",
            stream: "scheduled-tasks",
            entry: { scheduleTaskId, chatId, event: "run_complete", runIso, status },
        },
    ]

    if (nextState !== "cancelled") {
        effects.push({
            type: "schedule_timer_set",
            chatId, scheduleTaskId, rule: task.rule,
        })
    }

    dbg("SCHED-DONE", `${scheduleTaskId} run ${runIso} → ${status}`)
    return {
        stateChanges: {
            specialData: {
                scheduledTaskByChatId: {
                    [chatId]: {
                        [scheduleTaskId]: {
                            state: nextState,
                            currentRun: undefined,
                            tracking: {
                                totalRuns,
                                lastRunAt: new Date().toISOString(),
                                lastRunStatus: status,
                                lastRunSummary: (summary ?? "").slice(0, 300),
                                runHistory: nextHistory,
                            },
                        },
                    },
                },
            },
        },
        effects,
    }
}
