// lib/event-handlers/scheduled-task-worker-overflow.js
//
// Fired when a scheduled-task worker exceeds its budget (= the rule's
// repeat interval) without producing report.md. Instead of killing the
// worker, we:
//   1. Set skipNext so the next fire doesn't pile on
//   2. Send a warning to the user
//   3. Let the worker keep running — it may still finish

import { versionedImport } from "../version.js"
const { dbg } = await versionedImport("../logging.js", import.meta)
const { findScheduledTask, scheduleCommandLinks } = await versionedImport("../scheduled-task-actions.js", import.meta)
const { escapeHtml: esc } = await versionedImport("../pure/html.js", import.meta)

export default function handle(event, _core) {
    const { chatId, scheduleTaskId, runIso, budgetMs } = event
    const mins = Math.round((budgetMs ?? 0) / 60_000)
    dbg("SCHED-OVERFLOW", `${scheduleTaskId} run ${runIso} overflowed budget (${mins}m); setting skipNext`)

    return {
        stateChanges: {
            specialData: {
                scheduledTaskByChatId: {
                    [chatId]: {
                        [scheduleTaskId]: {
                            tracking: { skipNext: true },
                        },
                    },
                },
            },
        },
        effects: [
            {
                type: "send_text_to_user",
                chatId,
                text: `⚠️ Scheduled task <code>${esc(scheduleTaskId)}</code> is still running after its ${mins}m budget (= repeat interval).\n\nSkipping the next trigger to let it finish. The worker is still alive.\n\n${scheduleCommandLinks(scheduleTaskId)}`,
                options: { parse_mode: "HTML" },
            },
            {
                type: "cold_append",
                stream: "scheduled-tasks",
                entry: { scheduleTaskId, chatId, event: "overflow", runIso, budgetMs },
            },
        ],
    }
}
