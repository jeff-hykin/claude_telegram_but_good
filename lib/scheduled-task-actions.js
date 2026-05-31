// lib/scheduled-task-actions.js
//
// Pure helpers for the /schedule feature, mirroring lib/long-task-actions.js.
// Used by chat-user.js, commands/cron.js, and the scheduled-task
// event handlers.

import { versionedImport } from "./version.js"
const { escapeMarkdown: esc } = await versionedImport("./pure/markdown.js", import.meta)

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
    return [
        `/schedule_status_${scheduleTaskId}`,
        `/schedule_view_${scheduleTaskId}`,
        `/schedule_edit_${scheduleTaskId}`,
        `/schedule_pause_${scheduleTaskId}`,
        `/schedule_cancel_${scheduleTaskId}`,
    ].join("\n")
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
                    text: `Unknown scheduled task: ${scheduleTaskId}`,
                    options: {},
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
                    text: `Scheduled task ${scheduleTaskId} is already cancelled.`,
                    options: {},
                },
            ],
        }
    }
    // Mutate state under the task's OWNING chat (found.chatId), not the
    // chat that issued the cancel. Otherwise cancelling from a different
    // chat creates a ghost entry under the requester chat while the
    // original entry stays in its old state. The user-facing confirmation
    // still goes back to the requester (chatId).
    return {
        stateChanges: {
            specialData: {
                scheduledTaskByChatId: {
                    [found.chatId]: {
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
                entry: { scheduleTaskId, chatId: found.chatId, requestedBy: chatId, event: "cancelled" },
            },
            {
                type: "send_text_to_user",
                chatId,
                text: `Cancelled scheduled task ${scheduleTaskId}.`,
                options: {},
            },
        ],
    }
}
