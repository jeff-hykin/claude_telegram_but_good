// lib/event-handlers/scheduled-task-definition-submitted.js
//
// Handler for the MCP tool submit_scheduled_task_definition. Mirrors
// long-task-definition-submitted.js: validates, locks the task in
// state "scheduled", writes a definition_of_done.md + rule.json to
// the task directory, emits a schedule_timer_set to register the
// first fire, logs, and replies to the caller.

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { paths } = await versionedImport("../paths.js", import.meta)
const { validateRule } = await versionedImport("../scheduler/index.js", import.meta)
const { findScheduledTask, scheduleCommandLinks } = await versionedImport("../scheduled-task-actions.js", import.meta)
const { escapeHtml: esc } = await versionedImport("../pure/html.js", import.meta)
const { join } = await versionedImport("../../imports.js", import.meta)
const { makeReplyTo } = await versionedImport("../pure/reply-to.js", import.meta)

function replyError(event, message) {
    return {
        effects: [
            {
                type: "ipc_respond",
                conn: event._conn,
                message: {
                    type: "tool_response",
                    requestId: event.requestId,
                    result: {
                        content: [{ type: "text", text: message }],
                        isError: true,
                    },
                },
            },
        ],
    }
}

export default function handle(event, core) {
    const { scheduleTaskId, sessionId, rule, definitionOfDone, title } = event

    if (!scheduleTaskId || typeof definitionOfDone !== "string" || !definitionOfDone.trim()) {
        dbg("SCHED-SUB", `invalid event: scheduleTaskId=${scheduleTaskId} definition=${!!definitionOfDone}`)
        return replyError(event, "invalid request: scheduleTaskId and non-empty definitionOfDone are required")
    }

    const found = findScheduledTask(core.specialData, scheduleTaskId)
    if (!found) {
        dbg("SCHED-SUB", `scheduled task not found: ${scheduleTaskId}`)
        return replyError(event, `scheduled task ${scheduleTaskId} not found`)
    }
    const { chatId, task } = found

    if (task.draftingSessionId !== sessionId) {
        dbg("SCHED-SUB", `session mismatch: draftingSessionId=${task.draftingSessionId} sessionId=${sessionId}`)
        return replyError(
            event,
            `session mismatch: scheduled task is owned by ${task.draftingSessionId}, not ${sessionId}`,
        )
    }
    if (task.state !== "defining") {
        dbg("SCHED-SUB", `wrong state: ${task.state}`)
        return replyError(event, `scheduled task ${scheduleTaskId} is in state "${task.state}", not "defining"`)
    }

    const check = validateRule(rule)
    if (!check.ok) {
        dbg("SCHED-SUB", `invalid rule: ${check.error}`)
        return replyError(event, `invalid rule: ${check.error}`)
    }

    dbg("SCHED-SUB", `locking scheduled task ${scheduleTaskId}`)

    const taskDir = paths.scheduledTaskDir(scheduleTaskId)
    const defPath = join(taskDir, "definition_of_done.md")
    const rulePath = join(taskDir, "rule.json")

    return {
        stateChanges: {
            specialData: {
                scheduledTaskByChatId: {
                    [chatId]: {
                        [scheduleTaskId]: {
                            state: "scheduled",
                            definitionOfDone,
                            rule,
                            title: title ?? task.title,
                            draftingSessionId: undefined,
                        },
                    },
                },
            },
        },
        effects: [
            { type: "mkdir", path: taskDir },
            { type: "write_file", path: defPath, content: definitionOfDone },
            { type: "write_file", path: rulePath, content: JSON.stringify(rule, null, 2) },
            {
                type: "cold_append",
                stream: "scheduled-tasks",
                entry: {
                    scheduleTaskId,
                    chatId,
                    event: "locked",
                    sessionId,
                    definitionLength: definitionOfDone.length,
                },
            },
            {
                type: "schedule_timer_set",
                chatId,
                scheduleTaskId,
                rule,
            },
            {
                type: "ipc_respond",
                conn: event._conn,
                message: {
                    type: "tool_response",
                    requestId: event.requestId,
                    result: {
                        content: [
                            { type: "text", text: "Scheduled task locked. First fire is registered." },
                        ],
                    },
                },
            },
            {
                type: "send_text_to_user",
                replyTo: makeReplyTo({ chatId, threadId: null, setBy: "scheduled-task-definition-submitted:locked" }),
                text:
                    `Scheduled task <code>${esc(scheduleTaskId)}</code> locked.\n\n` +
                    scheduleCommandLinks(scheduleTaskId),
                options: { parse_mode: "HTML" },
            },
        ],
    }
}
