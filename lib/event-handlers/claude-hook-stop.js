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
// handler uses to bypass the timer delay (a stall
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
//                                      Schedule a delayed nudge timer.
//
// pendingNudgeAction replaces the old `nudgedForInbound` boolean — it
// encodes what to DO on Stop instead of whether the "did it already"
// flag was set.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { paths } = await versionedImport("../paths.js", import.meta)
const { escapeHtml: esc } = await versionedImport("../pure/html.js", import.meta)
const { replyToForSession, sendEffect, sendFileEffect } = await versionedImport("../pure/reply-to.js", import.meta)

// How long to wait after a Stop before nudging. Each new Stop resets
// the timer, so rapid multi-turn work doesn't trigger nudges. The
// nudge only fires when the agent truly goes quiet.
const REPLY_NUDGE_DELAY_MS = 2 * 60 * 1000  // 2 minutes for reply nudge
const TASK_NUDGE_DELAY_MS = 2 * 60 * 1000   // 2 minutes for task report nudge

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
        // Schedule a delayed nudge. If another Stop fires before the
        // timer, it resets. If the agent sends a reply, chat-user.js
        // clears pendingNudgeAction which makes the timer a no-op.
        dbg("HOOK-STOP", `scheduling reply nudge timer for ${event.sessionId} (${REPLY_NUDGE_DELAY_MS}ms)`)
        effects.push({
            type: "set_timer",
            delayMs: REPLY_NUDGE_DELAY_MS,
            event: {
                type: "stop_nudge_fire",
                sessionId: event.sessionId,
                nudgeType: "reply",
            },
        })
    } else if (action === "taskCheck") {
        const taskId = session.longTaskId
        const chatId = taskId ? findChatIdForTask(core, taskId) : null
        const task = chatId ? core.specialData?.longTaskByChatId?.[chatId]?.[taskId] : null

        if (!task) {
            dbg("HOOK-STOP", `taskCheck: no task found for ${taskId} — clearing`)
            sessionPatch.longTaskId = undefined
            sessionPatch.pendingNudgeAction = "none"
        } else if (task.state === "defining") {
            dbg("HOOK-STOP", `taskCheck: task ${taskId} still defining, keeping taskCheck for next Stop`)
        } else if (task.state !== "in_progress") {
            dbg("HOOK-STOP", `taskCheck: task ${taskId} state=${task.state}, no action`)
            sessionPatch.pendingNudgeAction = "none"
        } else if (reportMdExists(taskId)) {
            // The worker wrote the report. Fire the critic immediately
            // (no timer — report.md means they're done).
            dbg("HOOK-STOP", `taskCheck: report.md exists for ${taskId} — spawning critic`)
            effects.push({
                type: "spawn_critic",
                taskId,
                attempt: 1,
            })
            const criticReplyTo = replyToForSession(event.sessionId, core, "hook-stop/critic", chatId)
            const criticEffect = sendEffect(
                criticReplyTo,
                `Critic running on <code>${esc(taskId)}</code> ` +
                `(report.md received)…`,
                { parse_mode: "HTML" },
            )
            criticEffect.stashCriticMessageIdOnTask = { chatId, taskId }
            effects.push(criticEffect)
            const reportPath = paths.longTaskDir(taskId) + "/report.md"
            effects.push(sendFileEffect(
                criticReplyTo,
                reportPath,
                `report-${taskId}.md`,
            ))
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
                        },
                    },
                },
            }
            sessionPatch.pendingNudgeAction = "none"
        } else {
            // No report.md. Schedule a delayed nudge timer. Each Stop
            // resets the timer, so rapid multi-turn work won't trigger
            // it. Only fires when the agent truly goes quiet.
            dbg("HOOK-STOP", `taskCheck: scheduling task nudge timer for ${taskId} (${TASK_NUDGE_DELAY_MS}ms)`)
            effects.push({
                type: "set_timer",
                delayMs: TASK_NUDGE_DELAY_MS,
                event: {
                    type: "stop_nudge_fire",
                    sessionId: event.sessionId,
                    nudgeType: "taskReport",
                    taskId,
                    chatId,
                },
            })
        }
    }
    // action === "none" → just the base patch + cold-append. Nothing to add.

    // Drain the pending queue: if the session has queued messages from
    // /que (Telegram) or `cbg tell --que` (CLI), deliver the next one
    // now that the agent's turn is done. One message per turn — the
    // next stop hook drains the next one.
    const pendingQueue = session.pendingQueue ?? []
    if (pendingQueue.length > 0) {
        const next = pendingQueue[0]
        const remaining = pendingQueue.slice(1)
        dbg("HOOK-STOP", `draining /que for ${event.sessionId}: delivering 1, ${remaining.length} remaining (source=${next._source ?? "telegram"})`)
        effects.push({
            type: "deliver_channel_event",
            sessionId: event.sessionId,
            content: next.text,
            meta: {
                message_id: String(next.messageId ?? ""),
                chat_id: next.chatId,
            },
            _queueDrain: true,
            _chatId: next.chatId,
            _threadId: next.threadId ?? null,
        })
        // Notify the user via Telegram that the queued message was
        // delivered — but only for telegram-sourced entries. CLI-queued
        // entries (cbg tell --que / cbg ask --que) have no telegram
        // destination, and the CLI conn already sees its own response.
        if (next._source !== "cli") {
            const queReplyTo = replyToForSession(event.sessionId, core, "hook-stop/que-drain", next.chatId)
            if (queReplyTo.chatId) {
                const preview = next.text.length > 60 ? next.text.slice(0, 60) + "…" : next.text
                effects.push(sendEffect(
                    queReplyTo,
                    `Queued message delivered: <i>${esc(preview)}</i>${remaining.length > 0 ? `\n(${remaining.length} still queued)` : ""}`,
                    { parse_mode: "HTML" },
                ))
            }
        }
        sessionPatch.pendingQueue = remaining
        // Track the delivered message and activate the nudge system
        // so the agent gets reminded to reply if it goes idle.
        sessionPatch.lastInbound = {
            messageId: String(next.messageId ?? ""),
            chatId: next.chatId,
            ts: Date.now(),
            text: (next.text ?? "").slice(0, 500),
        }
        if (!sessionPatch.pendingNudgeAction || sessionPatch.pendingNudgeAction === "none") {
            sessionPatch.pendingNudgeAction = "askAgentToSendChatMessage"
        }
    }

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
