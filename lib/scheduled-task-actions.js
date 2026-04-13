// lib/scheduled-task-actions.js
//
// Pure helpers for the /schedule feature, mirroring lib/long-task-actions.js.
// Used by chat-user.js, commands/cron.js, and the scheduled-task
// event handlers.

import { versionedImport } from "./version.js"
const { escapeHtml: esc } = await versionedImport("./pure/html.js", import.meta)

/**
 * Find a scheduled task by id across all chats. Returns
 * `{ chatId, task }` or null.
 */
export function findScheduledTask(specialData, scheduleTaskId) {
    const byChat = specialData?.scheduledTaskByChatId ?? {}
    for (const [chatId, tasks] of Object.entries(byChat)) {
        if (tasks && tasks[scheduleTaskId] !== undefined) {
            return { chatId, task: tasks[scheduleTaskId] }
        }
    }
    return null
}

/**
 * Render the standard inline command row for a scheduled task.
 * Matches the style of taskCommandLinks in lib/long-task-actions.js.
 */
export function scheduleCommandLinks(scheduleTaskId) {
    const id = esc(scheduleTaskId)
    return [
        `/schedule_status_${id}`,
        `/schedule_view_${id}`,
        `/schedule_pause_${id}`,
        `/schedule_cancel_${id}`,
    ].join("   ")
}

/**
 * Build an Action that cancels a scheduled task. Marks it terminal,
 * clears the in-process timer, logs to cold storage, sends a user
 * confirmation. No-ops if the task is already cancelled or missing.
 */
export function buildScheduleCancelAction(core, chatId, scheduleTaskId) {
    const found = findScheduledTask(core.specialData, scheduleTaskId)
    if (!found) {
        return {
            effects: [
                {
                    type: "send_text_to_user",
                    chatId,
                    text: `Unknown scheduled task: <code>${esc(scheduleTaskId)}</code>`,
                    options: { parse_mode: "HTML" },
                },
            ],
        }
    }
    const task = found.task
    if (task.state === "cancelled") {
        return {
            effects: [
                {
                    type: "send_text_to_user",
                    chatId,
                    text: `Scheduled task <code>${esc(scheduleTaskId)}</code> is already cancelled.`,
                    options: { parse_mode: "HTML" },
                },
            ],
        }
    }
    return {
        stateChanges: {
            specialData: {
                scheduledTaskByChatId: {
                    [chatId]: {
                        [scheduleTaskId]: {
                            state: "cancelled",
                            currentRun: undefined,
                        },
                    },
                },
            },
        },
        effects: [
            { type: "schedule_timer_clear", scheduleTaskId },
            {
                type: "cold_append",
                stream: "scheduled-tasks",
                entry: { scheduleTaskId, chatId, event: "cancelled" },
            },
            {
                type: "send_text_to_user",
                chatId,
                text: `Cancelled scheduled task <code>${esc(scheduleTaskId)}</code>.`,
                options: { parse_mode: "HTML" },
            },
        ],
    }
}
