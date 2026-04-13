// ---------------------------------------------------------------------------
// claude_hook_stop handler.
//
// ⚠️  This file is one of several that mutate `chatSessions[sid]` state.
//    The full state machine (fields, states, transitions, invariants,
//    and the complete list of files allowed to touch these fields)
//    lives in docs/session-state.md. READ THAT FIRST before editing
//    any of the patches below — the transitions here are coupled to
//    activateWaitingState in chat-user.js, handleReply in
//    claude-channel.js, the long-task branches in critic-verdict.js,
//    stall-check.js, and the daemon reload path in main-server.js.
//
// Fired when Claude Code's Stop hook triggers OR when stall-check.js
// synthesizes a Stop after detecting a frozen screen buffer. Both code
// paths produce the same event shape — the only difference is
// `event.synthetic = true` on the stall-fired version, which this
// handler uses to skip the `consecutiveIdleStops < 2` guard (a stall
// already counts as "no progress for a minute").
//
// Responsibilities:
//   1. Record lastStopAt / lastActive on the session, transition status
//      from working/frozen → idle.
//   2. Dispatch on session.pendingNudgeAction:
//        "none"                      → nothing to do.
//        "askAgentToSendChatMessage" → fire the reply-tool reminder,
//                                      clear pendingNudgeAction.
//        "taskCheck"                 → look up the session's long task.
//                                      If report.md exists, spawn critic.
//                                      If not, maybe nudge for report
//                                      (synthetic OR consecutiveIdleStops≥2).
//
// pendingNudgeAction replaces the old `nudgedForInbound` boolean — it
// encodes what to DO on Stop instead of whether the "did it already"
// flag was set.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { paths } = await versionedImport("../paths.js", import.meta)

const REPLY_NUDGE_TEXT = "[automated reminder] You received a Telegram message but haven't replied yet. Please call the telegram reply tool now to respond to the user."

const NUDGE_REPORT_THRESHOLD = 2 // consecutive real Stops with no progress before nudging

function reportMdExists(taskId) {
    try {
        const path = paths.longTaskDir(taskId) + "/report.md"
        Deno.statSync(path)
        return true
    } catch (e) {
        if (e instanceof Deno.errors.NotFound) {
            return false
        }
        dbg("HOOK-STOP", `report.md stat failed for ${taskId}:`, e)
        return false
    }
}

function findChatIdForTask(core, taskId) {
    const byChat = core.specialData?.longTaskByChatId ?? {}
    for (const [chatId, tasks] of Object.entries(byChat)) {
        if (tasks && tasks[taskId] !== undefined) {
            return chatId
        }
    }
    return null
}

function reportNudgeText(taskId) {
    const dir = paths.longTaskDir(taskId)
    return (
        `[long task ${taskId}]\n` +
        `If you are done, please write ${dir}/report.md summarizing what you ` +
        `accomplished and why each requirement is met. Include the PWD, branch, ` +
        `files changed, and concrete evidence — the critic has no other context.\n` +
        `If you are not done, please continue working, logging progress to ` +
        `${dir}/progress.md, and write report.md when done.`
    )
}

export default function handle(event, core) {
    if (!event.sessionId) {
        dbg("HOOK-STOP", "no sessionId — skipping")
        return { stateChanges: {}, effects: [] }
    }

    const session = core.chatSessions?.[event.sessionId]
    if (!session) {
        dbg("HOOK-STOP", `no session for ${event.sessionId} — skipping`)
        return { stateChanges: {}, effects: [] }
    }

    const ts = event.ts ?? Date.now()
    const isSynthetic = event.synthetic === true

    dbg(
        "HOOK-STOP",
        `${isSynthetic ? "synthetic " : ""}stop ${event.sessionId} @ ${ts} pending=${session.pendingNudgeAction ?? "none"}`,
    )

    // Base patch: always update timestamps and status. Status becomes
    // idle regardless of how the Stop was produced — the agent has
    // ended its turn (real Stop) or been declared stuck (synthetic).
    const sessionPatch = {
        lastStopAt: ts,
        lastActive: ts,
        status: "idle",
    }

    const effects = [
        {
            type: "cold_append",
            stream: "hooks",
            entry: {
                ts,
                sessionId: event.sessionId,
                claudePid: event.claudePid ?? null,
                kind: "stop",
                synthetic: isSynthetic,
            },
        },
    ]

    // The session-level patch set accumulates into stateChanges at the
    // end. Task-level patches live on specialData.longTaskByChatId.
    let specialDataPatch = null

    const action = session.pendingNudgeAction ?? "none"

    if (action === "askAgentToSendChatMessage") {
        // Fire the reply-tool reminder and clear the action.
        effects.push({
            type: "send_text_to_claude",
            sessionId: event.sessionId,
            text: REPLY_NUDGE_TEXT,
        })
        sessionPatch.pendingNudgeAction = "none"
        dbg("HOOK-STOP", `fired reply nudge for ${event.sessionId}`)
    } else if (action === "taskCheck") {
        const taskId = session.longTaskId
        const chatId = taskId ? findChatIdForTask(core, taskId) : null
        const task = chatId ? core.specialData?.longTaskByChatId?.[chatId]?.[taskId] : null

        if (!task) {
            // longTaskId points to nothing — stale. Clear it.
            dbg("HOOK-STOP", `taskCheck: no task found for ${taskId} — clearing`)
            sessionPatch.longTaskId = undefined
            sessionPatch.pendingNudgeAction = "none"
        } else if (task.state !== "in_progress") {
            // Task has left in_progress (e.g. escalated, awaiting_clarification).
            // Nothing for this handler to do — the state machine for those
            // branches runs elsewhere. Keep longTaskId so the session still
            // knows it owns the task, but drop the nudge action.
            dbg("HOOK-STOP", `taskCheck: task ${taskId} state=${task.state}, no action`)
            sessionPatch.pendingNudgeAction = "none"
        } else if (reportMdExists(taskId)) {
            // The worker wrote the report. Fire the critic.
            dbg("HOOK-STOP", `taskCheck: report.md exists for ${taskId} — spawning critic`)
            effects.push({
                type: "spawn_critic",
                taskId,
                attempt: 1,
            })
            effects.push({
                type: "cold_append",
                stream: "long-tasks",
                entry: {
                    event: "critic_spawned",
                    taskId,
                    chatId,
                    trigger: isSynthetic ? "stall_detect" : "stop_hook",
                    attempt: 1,
                },
            })
            specialDataPatch = {
                longTaskByChatId: {
                    [chatId]: {
                        [taskId]: {
                            criticCallCount: (task.criticCallCount ?? 0) + 1,
                            criticLastCallAt: ts,
                            consecutiveIdleStops: 0,
                        },
                    },
                },
            }
            // Clear the nudge action — next step will be dictated by the
            // critic_verdict event, not by another Stop.
            sessionPatch.pendingNudgeAction = "none"
        } else {
            // No report.md. Decide whether to nudge.
            const prevIdleStops = task.consecutiveIdleStops ?? 0
            const nextIdleStops = prevIdleStops + 1
            const shouldNudge = isSynthetic || nextIdleStops >= NUDGE_REPORT_THRESHOLD

            if (shouldNudge) {
                dbg(
                    "HOOK-STOP",
                    `taskCheck: nudging worker for ${taskId} (synthetic=${isSynthetic}, idleStops=${nextIdleStops})`,
                )
                effects.push({
                    type: "send_text_to_claude",
                    sessionId: event.sessionId,
                    text: reportNudgeText(taskId),
                })
                effects.push({
                    type: "cold_append",
                    stream: "long-tasks",
                    entry: {
                        event: "nudged",
                        taskId,
                        chatId,
                        reason: isSynthetic ? "stall" : "consecutive_idle",
                        totalNudges: (task.totalNudges ?? 0) + 1,
                    },
                })
                specialDataPatch = {
                    longTaskByChatId: {
                        [chatId]: {
                            [taskId]: {
                                totalNudges: (task.totalNudges ?? 0) + 1,
                                lastNudgeAt: ts,
                                consecutiveIdleStops: 0,
                            },
                        },
                    },
                }
                // Leave pendingNudgeAction = "taskCheck" — we keep watching
                // until the report appears or the task terminates.
            } else {
                dbg(
                    "HOOK-STOP",
                    `taskCheck: no report for ${taskId} yet, idleStops ${prevIdleStops}→${nextIdleStops}`,
                )
                specialDataPatch = {
                    longTaskByChatId: {
                        [chatId]: {
                            [taskId]: { consecutiveIdleStops: nextIdleStops },
                        },
                    },
                }
                // pendingNudgeAction stays "taskCheck".
            }
        }
    }
    // action === "none" → just the base patch + cold-append. Nothing to add.

    const stateChanges = {
        chatSessions: {
            [event.sessionId]: sessionPatch,
        },
    }
    if (specialDataPatch) {
        stateChanges.specialData = specialDataPatch
    }

    return {
        stateChanges,
        effects,
    }
}
