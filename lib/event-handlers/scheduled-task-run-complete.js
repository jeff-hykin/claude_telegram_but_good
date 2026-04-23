// lib/event-handlers/scheduled-task-run-complete.js
//
// Finalize a scheduled-task run:
//   - update tracking (totalRuns, lastRunAt/Status/Summary, runHistory ring buffer)
//   - clear currentRun
//   - rearm the next fire (unless the task is cancelled)
//   - notify the user via Telegram with a short summary

import { versionedImport } from "../version.js"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
const { dbg } = await versionedImport("../logging.js", import.meta)
const { paths } = await versionedImport("../paths.js", import.meta)
const { findScheduledTask, scheduleCommandLinks } = await versionedImport("../scheduled-task-actions.js", import.meta)
const { escapeHtml: esc } = await versionedImport("../pure/html.js", import.meta)
const { join } = await versionedImport("../../imports.js", import.meta)
const { makeReplyTo, sendEffect, sendFileEffect } = await versionedImport("../pure/reply-to.js", import.meta)
const { loadAccess } = await versionedImport("../access.js", import.meta)

const RUN_HISTORY_MAX = 10
const MAX_ATTACHMENT_SIZE = 50 * 1024 * 1024 // 50MB

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

    // Build the user-facing message. For certified runs, prefer
    // response.md (user-facing message written by the worker) over
    // the raw report.md dump. Falls back to the summary from the
    // critic verdict.
    const effects = []
    const runDir = paths.scheduledTaskRunDir(scheduleTaskId, runIso)

    if (status === "certified") {
        const responsePath = join(runDir, "response.md")
        let responseText = null
        try {
            if (existsSync(responsePath)) {
                responseText = readFileSync(responsePath, "utf8").trim()
            }
        } catch (e) {
            dbg("SCHED-DONE", `read response.md failed:`, e)
        }

        const body = responseText || (summary ?? "").slice(0, 1500)
        const messageText = `/schedule_status_${scheduleTaskId}\n${body}`
        // Route to the user's DM (scheduled tasks aren't bound to a CC topic).
        const access = loadAccess()
        const replyTo = makeReplyTo({ chatId: chatId || access.allowFrom?.[0], threadId: null, setBy: "sched-run-complete" })
        effects.push(sendEffect(replyTo, messageText))

        // Send any files from attachments/ directory
        const attachDir = join(runDir, "attachments")
        try {
            if (existsSync(attachDir)) {
                const files = readdirSync(attachDir)
                for (const file of files) {
                    const filePath = join(attachDir, file)
                    try {
                        const size = statSync(filePath).size
                        if (size > 0 && size <= MAX_ATTACHMENT_SIZE) {
                            effects.push(sendFileEffect(replyTo, filePath, file))
                        } else if (size > MAX_ATTACHMENT_SIZE) {
                            dbg("SCHED-DONE", `skipping attachment ${file}: ${size} bytes exceeds limit`)
                        }
                    } catch (e) {
                        dbg("SCHED-DONE", `stat attachment ${file}:`, e)
                    }
                }
            }
        } catch (e) {
            dbg("SCHED-DONE", `read attachments dir:`, e)
        }
    } else {
        const access = loadAccess()
        const replyTo = makeReplyTo({ chatId: chatId || access.allowFrom?.[0], threadId: null, setBy: "sched-run-complete/error" })
        effects.push(sendEffect(
            replyTo,
            `⚠️ Scheduled task <code>${esc(scheduleTaskId)}</code> run errored.\n\n${esc((summary ?? "").slice(0, 500))}\n\n${scheduleCommandLinks(scheduleTaskId)}`,
            { parse_mode: "HTML" },
        ))
    }

    effects.push({
        type: "cold_append",
        stream: "scheduled-tasks",
        entry: { scheduleTaskId, chatId, event: "run_complete", runIso, status },
    })

    if (nextState !== "cancelled") {
        effects.push({
            type: "schedule_timer_set",
            chatId, scheduleTaskId, rule: task.rule,
            from: new Date().toISOString(),
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
