import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { paths } = await versionedImport("../paths.js", import.meta)
const { taskCommandLinks } = await versionedImport("../long-task-actions.js", import.meta)
const { escapeHtml: esc } = await versionedImport("../pure/html.js", import.meta)

function findTaskLocation(specialData, taskId) {
    const byChat = specialData?.longTaskByChatId ?? {}
    for (const [chatId, tasks] of Object.entries(byChat)) {
        if (tasks && tasks[taskId] !== undefined) {
            return { chatId, task: tasks[taskId] }
        }
    }
    return null
}

function replyError(event, message) {
    return {
        stateChanges: {},
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
    const { taskId, sessionId, definition } = event

    if (!taskId || typeof definition !== "string" || !definition.trim()) {
        dbg("LONG-TASK-DEF", `invalid event: taskId=${taskId} definition=${!!definition}`)
        return replyError(event, "invalid request: taskId and non-empty definition are required")
    }

    const location = findTaskLocation(core.specialData, taskId)
    if (!location) {
        dbg("LONG-TASK-DEF", `task not found: ${taskId}`)
        return replyError(event, `task ${taskId} not found`)
    }

    const { chatId, task } = location

    if (task.workerSessionId !== sessionId) {
        dbg(
            "LONG-TASK-DEF",
            `session mismatch: task.workerSessionId=${task.workerSessionId}, event.sessionId=${sessionId}`,
        )
        return replyError(
            event,
            `session mismatch: task is owned by ${task.workerSessionId}, not ${sessionId}`,
        )
    }

    if (task.state !== "defining") {
        dbg("LONG-TASK-DEF", `wrong state: ${task.state}`)
        return replyError(
            event,
            `task ${taskId} is in state "${task.state}", not "defining"`,
        )
    }

    if (task.definition) {
        dbg("LONG-TASK-DEF", `definition already submitted for ${taskId}`)
        return replyError(event, `definition already submitted for task ${taskId}`)
    }

    dbg(
        "LONG-TASK-DEF",
        `accepted definition for ${taskId} (${definition.length} chars)`,
    )

    return {
        stateChanges: {
            specialData: {
                longTaskByChatId: {
                    [chatId]: {
                        [taskId]: {
                            state: "in_progress",
                            definition,
                        },
                    },
                },
            },
        },
        effects: [
            {
                type: "ipc_respond",
                conn: event._conn,
                message: {
                    type: "tool_response",
                    requestId: event.requestId,
                    result: {
                        content: [
                            { type: "text", text: "Definition received. Begin work." },
                        ],
                    },
                },
            },
            // Cold backup of the definition as markdown. Restart recovery
            // doesn't strictly need this (specialData.json persists the
            // definition field too) but the plan calls for a dedicated
            // on-disk copy and it's cheap. Cleaned up by the terminal
            // transitions in critic-verdict.js and chat-user.js's
            // handleTaskCancel.
            {
                type: "write_file",
                path: paths.longTaskDefinitionBackupFile(taskId),
                content: definition,
            },
            {
                type: "cold_append",
                stream: "long-tasks",
                entry: {
                    taskId,
                    chatId,
                    event: "definition_locked",
                    sessionId,
                    definitionLength: definition.length,
                },
            },
            // User-facing "task started" message moved here from
            // handleTaskCreate. Showing it at task-create time was
            // misleading — the worker hasn't actually started yet, it's
            // still drafting / asking clarifying questions. This fires
            // only once the worker locks the definition, which is the
            // real "task started" moment.
            {
                type: "send_text_to_user",
                chatId,
                text:
                    `Task <code>${esc(taskId)}</code> confirmed to be understood by agent` +
                    `\n\n` +
                    taskCommandLinks(taskId),
                options: { parse_mode: "HTML" },
            },
        ],
    }
}
