// lib/event-handlers/create-scheduled-task.js
//
// Handler for the create_scheduled_task MCP tool. Creates a scheduled
// task directly in "scheduled" state, skipping the Telegram /schedule
// drafting flow. Validates the rule, writes definition_of_done.md and
// rule.json, registers the first timer fire, and replies to the caller.

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { paths } = await versionedImport("../paths.js", import.meta)
const { validateRule } = await versionedImport("../scheduler/index.js", import.meta)
const { scheduleCommandLinks } = await versionedImport("../scheduled-task-actions.js", import.meta)
const { randomHex } = await versionedImport("../pure/ids.js", import.meta)
const { escapeHtml: esc } = await versionedImport("../pure/html.js", import.meta)

function ccThreadOpts(core, sessionId) {
    const threadId = core?.chatState?.commandCenter?.topicMap?.[sessionId]
    return threadId != null ? { message_thread_id: Number(threadId) } : {}
}
const { join } = await versionedImport("../../imports.js", import.meta)
const { loadAccess } = await versionedImport("../access.js", import.meta)

function replyError(event, message) {
    return {
        effects: [{
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
        }],
    }
}

function generateUniqueScheduleId(core) {
    const existing = new Set()
    const byChat = core.specialData?.scheduledTaskByChatId ?? {}
    for (const tasks of Object.values(byChat)) {
        for (const id of Object.keys(tasks ?? {})) { existing.add(id) }
    }
    let id
    do { id = `sch_${randomHex(3)}` } while (existing.has(id))
    return id
}

export default function handle(event, core) {
    const { title, description, rule, definitionOfDone } = event

    if (!title || typeof title !== "string" || !title.trim()) {
        return replyError(event, "title is required")
    }
    if (typeof definitionOfDone !== "string" || !definitionOfDone.trim()) {
        return replyError(event, "definitionOfDone is required and must be non-empty")
    }
    if (!rule || typeof rule !== "object") {
        return replyError(event, "rule is required and must be an object")
    }

    const check = validateRule(rule)
    if (!check.ok) {
        dbg("CREATE-SCHED", `invalid rule: ${check.error}`)
        return replyError(event, `invalid rule: ${check.error}`)
    }

    // Resolve a chatId for storing the task. Use the first allowFrom
    // user as the "owner" chat, since this tool may be called from a
    // CLI session that has never sent a Telegram message.
    const access = loadAccess()
    const chatId = (access.allowFrom ?? [])[0] ?? "cli"

    const scheduleTaskId = generateUniqueScheduleId(core)
    const createdAt = new Date().toISOString()
    const newTask = {
        id: scheduleTaskId,
        title: title.trim(),
        originalPrompt: description ?? title,
        createdAt,
        state: "scheduled",
        draftingSessionId: undefined,
        definitionOfDone,
        rule,
        tracking: {
            totalRuns: 0,
            lastRunAt: null,
            lastRunStatus: null,
            lastRunSummary: null,
            nextFireAt: null,
            skipNext: false,
            runHistory: [],
        },
        currentRun: null,
    }

    const taskDir = paths.scheduledTaskDir(scheduleTaskId)
    const defPath = join(taskDir, "definition_of_done.md")
    const rulePath = join(taskDir, "rule.json")

    dbg("CREATE-SCHED", `creating scheduled task ${scheduleTaskId} ("${title}") directly`)

    return {
        stateChanges: {
            specialData: {
                scheduledTaskByChatId: {
                    [chatId]: { [scheduleTaskId]: newTask },
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
                    sessionId: event.sessionId,
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
                        content: [{
                            type: "text",
                            text: `Scheduled task ${scheduleTaskId} created and armed. Title: "${title}". Use /schedule_status_${scheduleTaskId} in Telegram to check status.`,
                        }],
                    },
                },
            },
            {
                type: "send_text_to_user",
                chatId,
                text:
                    `Scheduled task <code>${esc(scheduleTaskId)}</code> created: <b>${esc(title)}</b>\n\n` +
                    scheduleCommandLinks(scheduleTaskId),
                options: { parse_mode: "HTML", ...ccThreadOpts(core, event.sessionId) },
            },
        ],
    }
}
