// ---------------------------------------------------------------------------
// critic_verdict event handler.
//
// The critic subprocess (lib/effects/critic-subprocess.js) spawns `claude -p`
// asynchronously when a `spawn_critic` effect fires. When that subprocess
// finishes, it enqueues a `critic_verdict` event. This handler decides what
// to do with the verdict:
//
//   "certified"            -> mark task complete, notify worker, drop task from
//                             the hot set, archive to cold storage.
//   "revisions" / "anomaly"-> archive the requested_revisions.md under
//                             revisions/requested_revisions.<ts>.md, delete
//                             the old report.md so the worker must write a
//                             fresh one, and transition state back to
//                             "in_progress".
//   "clarification_needed" -> the definition itself is unclear; ask the user.
//   "indecisive" / "error" -> retry up to 3 attempts, then escalate to user.
//   "dry-run"              -> dry-run mode, just log to cold storage.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { escapeHtml } = await versionedImport("../pure/html.js", import.meta)
const { paths } = await versionedImport("../paths.js", import.meta)

/**
 * Produce the effect that reports a critic verdict to the user.
 *
 * If the task has a `criticRunningMessageId` (stashed when the
 * "Critic running on <id>…" message was originally sent by
 * claude-hook-stop.js), we EDIT that message in place so the user
 * sees a single running row per critic cycle that transitions from
 * "running" → "verdict" instead of two messages. If no id is
 * stashed (edge case: task loaded from persistence without the id,
 * or the original send failed), fall back to sending a new message.
 */
function criticStatusEffect(task, chatId, text) {
    if (task?.criticRunningMessageId && task?.criticRunningChatId != null) {
        return {
            type: "edit_telegram_message",
            chatId: task.criticRunningChatId,
            messageId: task.criticRunningMessageId,
            text,
            options: { parse_mode: "HTML" },
        }
    }
    return {
        type: "send_text_to_user",
        chatId,
        text,
        options: { parse_mode: "HTML" },
    }
}

function handleCertified(event, core, task) {
    const { taskId, chatId, elapsedMs } = event
    const workerSessionId = task.workerSessionId
    dbg("CRITIC-VERDICT", `certified taskId=${taskId} chatId=${chatId}`)

    const effects = []

    if (chatId) {
        effects.push(criticStatusEffect(
            task,
            chatId,
            `\u2705 Task <code>${escapeHtml(taskId)}</code> certified by critic.`,
        ))
    }

    // We deliberately do NOT notify the worker on certified. Earlier we
    // asked the worker to "notify the user with a short summary", but
    // CBG already posts its own `✅ Task <id> certified` message (via
    // the edited "Critic running…" message in criticStatusEffect above)
    // — a second worker-generated summary was redundant for the user.
    // The worker's longTaskId is cleared below so the session is free
    // for the next task; there's nothing else it needs to do.

    effects.push({
        type: "cold_append",
        stream: "long-tasks",
        entry: {
            event: "certified",
            taskId,
            chatId,
            elapsedMs,
        },
    })

    // Delete the on-disk definition backup written by
    // long-task-definition-submitted.js. Idempotent — if the file is
    // already gone (prior failure, race, etc.), delete_file logs and
    // moves on.
    effects.push({
        type: "delete_file",
        path: paths.longTaskDefinitionBackupFile(taskId),
    })

    // Drop the completed task from the hot set. mergeSessionData treats
    // `undefined` as a delete signal. Also clear the worker session's
    // longTaskId pointer and any lingering nudge action so the session
    // is free to host a new task immediately.
    const sessionClearPatch = workerSessionId
        ? {
            chatSessions: {
                [workerSessionId]: {
                    longTaskId: undefined,
                    pendingNudgeAction: "none",
                },
            },
        }
        : {}
    return {
        stateChanges: {
            specialData: {
                longTaskByChatId: {
                    [chatId]: {
                        [taskId]: undefined,
                    },
                },
            },
            ...sessionClearPatch,
        },
        effects,
    }
}

function handleRevisions(event, core, task) {
    const { taskId, chatId, verdict, attempt } = event
    const workerSessionId = task.workerSessionId

    if (verdict === "anomaly") {
        dbg(
            "CRITIC-VERDICT",
            `ANOMALY taskId=${taskId} — both certification.md and requested_revisions.md exist; treating as revisions`,
        )
    } else {
        dbg("CRITIC-VERDICT", `revisions taskId=${taskId} attempt=${attempt}`)
    }

    const taskDirAbs = paths.longTaskDir(taskId)
    // Filesystem-safe iso timestamp: replace colons (not allowed on some
    // FSes) and the dot in the milliseconds with dashes. `2026-04-13T03-12-45-123Z`.
    const tsTag = new Date(event.ts ?? Date.now()).toISOString().replace(/[:.]/g, "-")
    const archivedRevisionsPath = `${taskDirAbs}/revisions/requested_revisions.${tsTag}.md`

    const effects = []

    // Archive the critic's revision feedback under revisions/<ts>.md so
    // a history of iterations accrues on disk. The next critic run
    // won't see `requested_revisions.md` at the root (because we just
    // moved it) — meaning if the worker re-writes report.md and the
    // critic runs again, the critic's output directory is clean and
    // the critic produces a fresh requested_revisions.md or
    // certification.md based only on the new report.
    effects.push({
        type: "move_file",
        from: `${taskDirAbs}/requested_revisions.md`,
        to: archivedRevisionsPath,
    })

    // Delete the old report.md. The worker must write a fresh one for
    // the next critic iteration — this prevents a stale report sitting
    // on disk and tripping the Stop-hook's `reportMdExists` check,
    // which would re-spawn the critic against the exact same report
    // that just got "revisions" as the verdict.
    effects.push({
        type: "delete_file",
        path: `${taskDirAbs}/report.md`,
    })

    if (chatId) {
        effects.push(criticStatusEffect(
            task,
            chatId,
            `\u26A0\uFE0F Task <code>${escapeHtml(taskId)}</code>: critic requested revisions. Worker is re-drafting.`,
        ))
    }

    if (workerSessionId) {
        // See handleCertified: use deliver_channel_event (MCP channel
        // notification) so the worker reliably starts a new turn.
        // send_text_to_claude here goes through dtach -p, which only
        // registers if claude happens to be at the interactive prompt
        // — right after a Stop hook it isn't, so the message silently
        // vanishes and the worker never starts a revision turn.
        effects.push({
            type: "deliver_channel_event",
            sessionId: workerSessionId,
            content:
                `[long task ${taskId} — revisions requested]\n` +
                `The critic has requested revisions. Read ` +
                `${archivedRevisionsPath} ` +
                `(and any earlier files under ${taskDirAbs}/revisions/) ` +
                `and address each item, then write a new report.md at ` +
                `${taskDirAbs}/report.md.`,
            meta: {},
        })
    } else {
        dbg("CRITIC-VERDICT", `revisions ${taskId} but no workerSessionId on task`)
    }

    effects.push({
        type: "cold_append",
        stream: "long-tasks",
        entry: {
            event: verdict === "anomaly" ? "revisions_requested_anomaly" : "revisions_requested",
            taskId,
            chatId,
            attempt,
            archivedTo: archivedRevisionsPath,
        },
    })

    // Re-arm the worker session so the NEXT Stop (after the worker's
    // revision turn) actually takes the taskCheck branch. Without this
    // patch, pendingNudgeAction stays as "none" (claude-hook-stop set
    // it to none after spawning the critic, expecting the verdict
    // event to dictate the next step), and the Stop hook after the
    // revision write would silently no-op — the critic cycle would
    // never re-fire.
    const sessionRearmPatch = workerSessionId
        ? {
            chatSessions: {
                [workerSessionId]: {
                    pendingNudgeAction: "taskCheck",
                },
            },
        }
        : {}

    return {
        stateChanges: {
            specialData: {
                longTaskByChatId: {
                    [chatId]: {
                        [taskId]: {
                            state: "in_progress",
                            consecutiveIdleStops: 0,
                        },
                    },
                },
            },
            ...sessionRearmPatch,
        },
        effects,
    }
}

// handleClarification was removed. Tasks run without a user present after
// definition-lock, so the critic is NOT allowed to ask clarifying
// questions — the CRITIC_PROMPT tells it to pick the most defensible
// reading and judge against that. Any "clarification_needed" marker
// is no longer produced by the subprocess layer. If somehow a legacy
// verdict comes through, it's routed to handleRetry below, which will
// escalate to the user after 3 attempts.

function handleRetry(event, core, task) {
    const { taskId, chatId, verdict, details, attempt } = event
    dbg(
        "CRITIC-VERDICT",
        `retry-eligible verdict=${verdict} taskId=${taskId} attempt=${attempt}`,
    )

    if (attempt < 3) {
        // Spawn a fresh critic with a bumped attempt counter.
        return {
            stateChanges: {},
            effects: [
                {
                    type: "spawn_critic",
                    taskId,
                    attempt: attempt + 1,
                },
                {
                    type: "cold_append",
                    stream: "long-tasks",
                    entry: {
                        event: "critic_retry",
                        taskId,
                        chatId,
                        verdict,
                        attempt,
                        nextAttempt: attempt + 1,
                    },
                },
            ],
        }
    }

    // Give up — escalate to the user and park the task in a terminal
    // "escalated" state so a subsequent report write can't trigger
    // another 3-attempt cycle. The user must `/task_cancel_<id>` or
    // otherwise unstick it explicitly.
    dbg("CRITIC-VERDICT", `escalating taskId=${taskId} after ${attempt} attempts`)

    const effects = []

    if (chatId) {
        const detailsText = details ? String(details) : "(no details)"
        effects.push(criticStatusEffect(
            task,
            chatId,
            `\u274C Task <code>${escapeHtml(taskId)}</code>: critic failed after 3 attempts. ` +
            `Last error: <pre>${escapeHtml(detailsText)}</pre>` +
            `Please intervene.`,
        ))
    } else {
        dbg("CRITIC-VERDICT", `escalation ${taskId} but no chatId`)
    }

    effects.push({
        type: "cold_append",
        stream: "long-tasks",
        entry: {
            event: "critic_escalated",
            taskId,
            chatId,
            verdict,
            attempt,
            details: details ? String(details).slice(0, 2000) : null,
        },
    })

    // escalated is a terminal state — also clear the session pointer so
    // the session doesn't keep nudging for a task we've given up on.
    // The task entry itself stays in specialData for audit.
    const workerSessionId = task.workerSessionId
    const sessionClearPatch = workerSessionId
        ? {
            chatSessions: {
                [workerSessionId]: {
                    longTaskId: undefined,
                    pendingNudgeAction: "none",
                },
            },
        }
        : {}
    return {
        stateChanges: chatId
            ? {
                specialData: {
                    longTaskByChatId: {
                        [chatId]: {
                            [taskId]: { state: "escalated" },
                        },
                    },
                },
                ...sessionClearPatch,
            }
            : sessionClearPatch,
        effects,
    }
}

export default function handle(event, core) {
    const { taskId, chatId, verdict, attempt = 1 } = event

    if (!taskId) {
        dbg("CRITIC-VERDICT", "missing taskId")
        return { stateChanges: {}, effects: [] }
    }

    // Look up the task. May be missing if cancelled, completed, or if the
    // chatId on the event is wrong. Still log to cold storage either way.
    const task = core.specialData?.longTaskByChatId?.[chatId]?.[taskId]
    if (!task) {
        dbg(
            "CRITIC-VERDICT",
            `task ${taskId} not found at chatId=${chatId} or already removed (verdict=${verdict})`,
        )
        return {
            stateChanges: {},
            effects: [
                {
                    type: "cold_append",
                    stream: "long-tasks",
                    entry: {
                        event: "verdict_orphan",
                        taskId,
                        chatId,
                        verdict,
                        attempt,
                    },
                },
            ],
        }
    }

    switch (verdict) {
        case "certified":
            return handleCertified(event, core, task)
        case "revisions":
        case "anomaly":
            return handleRevisions(event, core, task)
        case "clarification_needed":
            // Legacy path — the subprocess no longer emits this verdict
            // (see critic-subprocess.js), but we treat any stale event
            // as a normal revisions request so the worker keeps going.
            dbg("CRITIC-VERDICT", `legacy clarification_needed for ${taskId}; routing to handleRevisions`)
            return handleRevisions(event, core, task)
        case "indecisive":
        case "error":
            return handleRetry(event, core, task)
        case "dry-run":
            dbg("CRITIC-VERDICT", `dry-run taskId=${taskId}`)
            return {
                stateChanges: {},
                effects: [
                    {
                        type: "cold_append",
                        stream: "long-tasks",
                        entry: { event: "dry_run", taskId, chatId },
                    },
                ],
            }
        default:
            dbg("CRITIC-VERDICT", `unknown verdict: ${verdict}`)
            return { stateChanges: {}, effects: [] }
    }
}
