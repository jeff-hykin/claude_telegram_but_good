// ---------------------------------------------------------------------------
// stop_nudge_fire handler.
//
// Fired by a delayed timer scheduled from claude-hook-stop.js. The Stop
// handler no longer nudges immediately — it schedules this timer instead.
// Each new Stop resets (re-schedules) the timer, so rapid multi-turn
// work doesn't trigger nudges. Only fires when the agent truly goes
// quiet for the delay period.
//
// Two nudge types:
//   "reply"      — agent hasn't replied to a user message
//   "taskReport" — agent hasn't written report.md for a long task
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { paths } = await versionedImport("../paths.js", import.meta)

const TASK_CHECKIN_MS = 30 * 60 * 1000

const REPLY_NUDGE_TEXT = "[automated reminder] You received a Telegram message but haven't replied yet. Please call the telegram reply tool now to respond to the user."

function reportNudgeText(taskId) {
    const dir = paths.longTaskDir(taskId)
    return (
        `[automated reminder] Your task (${taskId}) is in progress but no report.md has been written yet. ` +
        `If you are done, please write ${dir}/report.md summarizing what you ` +
        `did, including concrete evidence (commands run, test output, file paths). ` +
        `If you are not done, continue working — update ` +
        `${dir}/progress.md, and write report.md when done.`
    )
}

export default function handle(event, core) {
    const { sessionId, nudgeType, taskId, chatId } = event

    const session = core.chatSessions?.[sessionId]
    if (!session) {
        dbg("STOP-NUDGE", `session ${sessionId} gone — skipping`)
        return null
    }

    if (nudgeType === "reply") {
        // Only fire if pendingNudgeAction is still "askAgentToSendChatMessage".
        // If the agent already replied, chat-user.js or claude-channel.js
        // cleared it to "none".
        if (session.pendingNudgeAction !== "askAgentToSendChatMessage") {
            dbg("STOP-NUDGE", `reply nudge for ${sessionId}: action already ${session.pendingNudgeAction}, skipping`)
            return null
        }

        dbg("STOP-NUDGE", `firing reply nudge for ${sessionId}`)
        return {
            stateChanges: {
                chatSessions: {
                    [sessionId]: { pendingNudgeAction: "none" },
                },
            },
            effects: [{
                type: "send_text_to_claude",
                sessionId,
                text: REPLY_NUDGE_TEXT,
            }],
        }
    }

    if (nudgeType === "taskReport") {
        // Only fire if the session still owns this task and it's in_progress.
        if (session.longTaskId !== taskId) {
            dbg("STOP-NUDGE", `task nudge for ${sessionId}: no longer owns ${taskId}, skipping`)
            return null
        }
        if (session.pendingNudgeAction !== "taskCheck") {
            dbg("STOP-NUDGE", `task nudge for ${sessionId}: action is ${session.pendingNudgeAction}, skipping`)
            return null
        }

        const task = chatId
            ? core.specialData?.longTaskByChatId?.[chatId]?.[taskId]
            : null
        if (!task || task.state !== "in_progress") {
            dbg("STOP-NUDGE", `task nudge: ${taskId} not in_progress, skipping`)
            return null
        }

        // Check if report.md appeared in the meantime.
        try {
            Deno.statSync(paths.longTaskDir(taskId) + "/report.md")
            dbg("STOP-NUDGE", `task nudge: report.md exists for ${taskId}, skipping`)
            return null
        } catch {
            // No report — proceed with nudge.
        }

        dbg("STOP-NUDGE", `firing task report nudge for ${taskId} on ${sessionId}`)
        return {
            stateChanges: {
                specialData: {
                    longTaskByChatId: {
                        [chatId]: {
                            [taskId]: {
                                totalNudges: (task.totalNudges ?? 0) + 1,
                                lastNudgeAt: Date.now(),
                            },
                        },
                    },
                },
            },
            effects: [
                {
                    type: "send_text_to_claude",
                    sessionId,
                    text: reportNudgeText(taskId),
                },
                // Reset the 30-minute check-in timer.
                {
                    type: "set_timer",
                    delayMs: TASK_CHECKIN_MS,
                    event: { type: "task_checkin", sessionId, taskId },
                },
                {
                    type: "cold_append",
                    stream: "long-tasks",
                    entry: {
                        event: "nudged",
                        taskId,
                        chatId,
                        reason: "idle_timeout",
                        totalNudges: (task.totalNudges ?? 0) + 1,
                    },
                },
            ],
        }
    }

    dbg("STOP-NUDGE", `unknown nudge type: ${nudgeType}`)
    return null
}
