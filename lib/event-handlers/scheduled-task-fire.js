// lib/event-handlers/scheduled-task-fire.js
//
// A scheduled-task timer fired. Decide whether to kick off a run,
// skip it (skipNext set, terminal state, or previous run still in
// progress), and rearm the next fire.

import { versionedImport } from "../version.js"
const { dbg } = await versionedImport("../logging.js", import.meta)
const { findScheduledTask, scheduleCommandLinks } = await versionedImport("../scheduled-task-actions.js", import.meta)
const { escapeHtml: esc } = await versionedImport("../pure/html.js", import.meta)

export default function handle(event, core) {
    const { chatId, scheduleTaskId, fireIso } = event
    const found = findScheduledTask(core.specialData, scheduleTaskId)
    if (!found) {
        dbg("SCHED-FIRE", `task ${scheduleTaskId} not found; swallowing fire`)
        return null
    }
    const task = found.task
    if (task.state === "cancelled" || task.state === "completed" || task.state === "errored") {
        dbg("SCHED-FIRE", `task ${scheduleTaskId} terminal (${task.state}); skipping`)
        return null
    }
    if (task.state === "running") {
        dbg("SCHED-FIRE", `task ${scheduleTaskId} still running a previous fire; skipping + rearming`)
        return {
            effects: [
                { type: "schedule_timer_set", chatId, scheduleTaskId, rule: task.rule, from: new Date().toISOString() },
                {
                    type: "send_text_to_user",
                    chatId,
                    text: `⚠️ Scheduled task <code>${esc(scheduleTaskId)}</code> trigger skipped — previous run is still in progress.\n\n${scheduleCommandLinks(scheduleTaskId)}`,
                    options: { parse_mode: "HTML" },
                },
                {
                    type: "cold_append",
                    stream: "scheduled-tasks",
                    entry: {
                        scheduleTaskId, chatId, event: "skipped",
                        reason: "previous run still in progress", fireIso,
                    },
                },
            ],
        }
    }
    if (task.tracking?.skipNext) {
        dbg("SCHED-FIRE", `task ${scheduleTaskId} skipNext; clearing and rearming`)
        return {
            stateChanges: {
                specialData: {
                    scheduledTaskByChatId: {
                        [chatId]: {
                            [scheduleTaskId]: {
                                tracking: { skipNext: false },
                            },
                        },
                    },
                },
            },
            effects: [
                { type: "schedule_timer_set", chatId, scheduleTaskId, rule: task.rule, from: new Date().toISOString() },
                {
                    type: "cold_append",
                    stream: "scheduled-tasks",
                    entry: { scheduleTaskId, chatId, event: "skipped", reason: "skipNext", fireIso },
                },
            ],
        }
    }

    const runIso = fireIso ?? new Date().toISOString()
    dbg("SCHED-FIRE", `firing ${scheduleTaskId} as run ${runIso}`)
    return {
        stateChanges: {
            specialData: {
                scheduledTaskByChatId: {
                    [chatId]: {
                        [scheduleTaskId]: {
                            state: "running",
                            currentRun: {
                                runIso,
                                startedAt: new Date().toISOString(),
                                attempt: 1,
                            },
                        },
                    },
                },
            },
        },
        effects: [
            {
                type: "scheduled_task_worker_spawn",
                chatId, scheduleTaskId, runIso,
            },
            {
                type: "cold_append",
                stream: "scheduled-tasks",
                entry: { scheduleTaskId, chatId, event: "run_started", runIso },
            },
        ],
    }
}
