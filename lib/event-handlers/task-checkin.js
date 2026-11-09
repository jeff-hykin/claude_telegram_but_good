// ---------------------------------------------------------------------------
// task_checkin handler.
//
// Fired by a 30-minute timer as a backup nudge for long tasks. Ensures
// the worker checks in on progress even when it's running long builds
// or tests that don't produce Stop hooks.
//
// The timer is scheduled when a task enters in_progress and reset on:
//   - user messages to the session
//   - report.md submission (critic spawned)
//   - any other nudge
// Cancelled when the task completes or is cancelled.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { paths } = await versionedImport("../paths.js", import.meta)
const { sendEffect } = await versionedImport("../pure/reply-to.js", import.meta)
const { findRehomeCandidate, taskReplyTo, isLiveTaskState, TASK_CHECKIN_MS } = await versionedImport("../pure/long-task-ownership.js", import.meta)


// Hard floor on check-in cadence. set_timer can't be cancelled and a
// check-in is (re)scheduled from several places (in_progress start, user
// messages, report.md, other nudges, and its own reschedule), so many
// timers stack up and all come due together — spamming the worker. This
// gate (against the task's lastCheckinAt) guarantees at most one check-in
// per 20 min no matter how many timers pile up. Suppressed fires do NOT
// reschedule, so the stack collapses back to a single self-sustaining timer.
const MIN_CHECKIN_INTERVAL_MS = 20 * 60 * 1000

// How long a task's worker session may be missing before the user hears
// about it. A worker disappears whenever its dtach session dies (a daemon
// restart that the shim can't reconnect through, a crash, a reboot), and
// an in_progress task without a worker makes no progress and produces no
// output — so silence is the one thing it must not answer with.
const ORPHAN_ALERT_MS = 30 * 60 * 1000

// Ceiling on the gap between repeat orphan alerts. The gap doubles from
// ORPHAN_ALERT_MS until it hits this, so a task that can't be re-homed
// says so at roughly +30m, +1h30, +3h30, +5h30 — persistent enough that
// an overnight stall is waiting in the morning, quiet enough not to be
// scrolled past as spam.
const ORPHAN_REALERT_CAP_MS = 2 * 60 * 60 * 1000

function formatDuration(mins) {
    if (mins < 60) {
        return `${mins}m`
    }
    const h = Math.floor(mins / 60)
    const m = mins % 60
    return m > 0 ? `${h}h${m}m` : `${h}h`
}

/**
 * Hand an orphaned task to the session that now owns its topic.
 *
 * Mirrors what /task_resume does on reassignment, minus the
 * cancelled-state restoration (an orphaned task never left its state).
 * The old session's pointer is deliberately NOT touched: it either no
 * longer exists or is already busy with something else, which is why
 * we're here.
 */
function rehome(core, { task, taskId, chatId, heirId, formerId, now }) {
    dbg("TASK-CHECKIN", `${taskId}: re-homing from ${formerId} to ${heirId} (topic successor, state=${task.state})`)

    const dir = paths.longTaskDir(taskId)
    // A task that never got its definition locked can't be "continued" —
    // there is no progress.md and no definition of done, only the user's
    // original request. The heir has to restart the drafting step.
    const handoff = task.state === "defining"
        ? `[long task ${taskId} — reassigned to you, still being defined]\n` +
            `The session that was drafting this task's definition of done went away before locking it, ` +
            `so you own it now. Nothing has been built yet.\n\n` +
            `The user's original request was:\n` +
            (task.originalPrompt ?? "(not recorded)").split("\n").map(l => `> ${l}`).join("\n") + `\n\n` +
            `Write ${dir}/context.md, ask the user anything you genuinely need, then call ` +
            `submit_long_task_definition with the definition of done to start the work.`
        : `[long task ${taskId} — reassigned to you]\n` +
            `The previous worker session (${formerId}) went away mid-task, so you own this now. ` +
            `Read ${dir}/ (context.md, progress.md, and the definition of done) to see where it left off, ` +
            `then continue the work. Write progress.md as you go and ${dir}/report.md when genuinely done.`
    const announce = task.state === "defining"
        ? `*${taskId}* lost the session that was defining it (\`${formerId}\`) and has been handed to \`${heirId}\`, ` +
            `which restarts from your original request. Use /task_status_${taskId} to check on it.`
        : `*${taskId}* lost its worker (\`${formerId}\`) and has been handed to \`${heirId}\`, ` +
            `which picks up from progress.md. Use /task_status_${taskId} to check on it.`
    return {
        stateChanges: {
            specialData: {
                longTaskByChatId: {
                    [chatId]: {
                        [taskId]: {
                            workerSessionId: heirId,
                            // Clear the orphan markers so a later stall
                            // starts its alert clock from scratch rather
                            // than inheriting a spent backoff.
                            orphanedSince: undefined,
                            orphanAlertedAt: undefined,
                            orphanAlertCount: undefined,
                            rehomedAt: new Date(now).toISOString(),
                            previousSessionId: formerId,
                        },
                    },
                },
            },
            chatSessions: {
                // Only the two fields that make the heir the task's
                // worker. status/agentRequest are left alone on purpose:
                // they drive the reply-stall machinery, which is armed
                // with its own timer elsewhere, and claiming "working"
                // without arming that timer is a half-state. The
                // taskCheck chain below is the watchdog that matters.
                [heirId]: {
                    longTaskId: taskId,
                    pendingNudgeAction: "taskCheck",
                },
            },
        },
        effects: [
            sendEffect(
                taskReplyTo(core, { ...task, workerSessionId: heirId }, chatId, "task-checkin/rehome"),
                announce,
                { parse_mode: "Markdown" },
            ),
            {
                type: "deliver_channel_event",
                sessionId: heirId,
                content: handoff,
                meta: {},
            },
            {
                type: "cold_append",
                stream: "long-tasks",
                entry: { event: "rehomed", taskId, chatId, sessionId: heirId, previousSessionId: formerId, state: task.state },
            },
            // Start the new owner's check-in chain. The old chain is not
            // rescheduled here, and any timer already in flight for it
            // drops itself on the stale-owner check above.
            {
                type: "set_timer",
                delayMs: TASK_CHECKIN_MS,
                event: { type: "task_checkin", sessionId: heirId, taskId },
            },
        ],
    }
}

function chatIdLine(chatId) {
    return chatId ? ` The Telegram chat_id for this conversation is ${chatId} — pass it to the reply tool.` : ""
}

function checkinNudgeText(taskId, chatId) {
    const dir = paths.longTaskDir(taskId)
    return (
        `[automated check-in] It's been 30 minutes since your last check-in. ` +
        `Please briefly report your progress — what you've done, what's running, and what's next. ` +
        `Then pick exactly one: if there is still work left, write ${dir}/progress.md ` +
        `(current state, what's left, what's blocking you) and keep working — this is the normal, expected answer. ` +
        `If the task is genuinely finished, write ${dir}/report.md. ` +
        `Do NOT write report.md for work you know is unfinished, and do not shrink the task to fit what you have so far — ` +
        `an honest progress.md is always better than a report that argues for cut corners.` +
        chatIdLine(chatId)
    )
}

// Sent when report.md already exists but no critic has picked it up. The
// reviewer (critic) only spawns when the worker ends its turn (Stop hook),
// so a worker that wrote report.md and then went idle mid-turn leaves the
// task wedged: done-but-unverified, with nothing to advance it. This nudge
// prompts the worker to end its turn so the critic runs.
function reportStalledNudgeText(chatId) {
    return `[automated check-in] report.md exists for this task but the reviewer hasn't run yet. The reviewer only starts when you end your turn. If you believe you're done, end your turn now so it can evaluate your report. If you're still working, keep going and rewrite report.md when finished.` + chatIdLine(chatId)
}

// Sent while a task is still in `defining`: the worker was asked to draft
// a definition of done and hasn't locked one in. Either it is genuinely
// waiting on an answer from the user (fine — say so and keep waiting) or
// it has lost the thread, which is the case this nudge exists to catch.
function definingNudgeText(taskId, chatId) {
    const dir = paths.longTaskDir(taskId)
    return (
        `[automated check-in] Long task ${taskId} is still in the "defining" phase — no definition of done has been ` +
        `locked in yet, so no work has started. Pick exactly one: if you are waiting on an answer from the user, ` +
        `re-send the question (they may not have seen it). If you have enough to go on, write ${dir}/context.md ` +
        `and call submit_long_task_definition to lock the definition and begin. If you have lost track of this task, ` +
        `say so plainly rather than guessing.` +
        chatIdLine(chatId)
    )
}

function reportMdExists(taskId) {
    try {
        Deno.statSync(paths.longTaskDir(taskId) + "/report.md")
        return true
    } catch {
        return false
    }
}

function findChatIdForTask(core, taskId) {
    const byChat = core.specialData?.longTaskByChatId ?? {}
    for (const [chatId, tasks] of Object.entries(byChat)) {
        if (tasks?.[taskId] !== undefined) { return chatId }
    }
    return null
}

export default function handle(event, core) {
    const { sessionId, taskId } = event
    if (!sessionId || !taskId) {
        dbg("TASK-CHECKIN", "invalid event — missing sessionId or taskId")
        return null
    }

    const chatId = findChatIdForTask(core, taskId)
    const task = chatId ? core.specialData?.longTaskByChatId?.[chatId]?.[taskId] : null
    // `defining` is watched as well as `in_progress`. It used to be
    // excluded, which left a drafting task with no watchdog at all: if
    // its worker died (or just drifted off without calling
    // submit_long_task_definition) the task froze in `defining` forever
    // with nothing to nudge it, nothing to re-home it, and nobody told.
    // The window is short, but short isn't zero, and the user is sitting
    // there waiting for a task that no longer exists to anyone.
    if (!task || !isLiveTaskState(task.state)) {
        dbg("TASK-CHECKIN", `task ${taskId} not live (state=${task?.state}) — skipping`)
        return null
    }
    const defining = task.state === "defining"

    // A worker that has gone away used to end the chain here, which meant
    // the one watchdog over an in_progress task quietly died the moment
    // the task most needed attention: the work stops, nothing nudges it,
    // and nobody is told. Keep the timer alive instead, and say something
    // once the worker has stayed missing.
    const session = core.chatSessions?.[sessionId]
    const now = event.ts ?? Date.now()

    // /task_resume can hand the task to a different session. This timer
    // belongs to the session it was armed for, so once the task has moved
    // on, the chain is stale — drop it (the new owner has its own chain).
    // Without this it would keep firing forever and re-raise the orphan
    // alert against a task that already has a live worker.
    if (task.workerSessionId && task.workerSessionId !== sessionId) {
        dbg("TASK-CHECKIN", `${taskId}: chain for ${sessionId} is stale (owner is ${task.workerSessionId}) — dropping`)
        return null
    }

    if (!session || session.longTaskId !== taskId) {
        dbg("TASK-CHECKIN", `${taskId}: worker ${sessionId} ${session ? "no longer owns it" : "is gone"} — task is orphaned`)

        // Before telling anyone, try to fix it. A task's topic outlives
        // the session inside it, so whoever `/refresh` or `/new` put
        // there is the natural successor — same conversation, same
        // user intent. Recovering without being asked is the whole
        // point: an overnight task that waits for the user to notice
        // and type /task_resume has already lost the night.
        const heirId = findRehomeCandidate(core, task, taskId)
        if (heirId) {
            return rehome(core, { task, taskId, chatId, heirId, formerId: sessionId, now })
        }

        const orphanedSince = task.orphanedSince ?? now
        const alertCount = task.orphanAlertCount ?? 0
        // Re-alert on a widening gap rather than once and then silence.
        // The old one-shot latch meant a task could sit orphaned for six
        // hours having said so exactly once, which is indistinguishable
        // from a task that is working fine — the silence WAS the damage.
        const sinceLastAlert = task.orphanAlertedAt != null
            ? now - task.orphanAlertedAt
            : now - orphanedSince
        const dueIn = alertCount === 0
            ? ORPHAN_ALERT_MS
            : Math.min(ORPHAN_ALERT_MS * (2 ** alertCount), ORPHAN_REALERT_CAP_MS)
        const shouldAlert = sinceLastAlert >= dueIn

        const effects = [{
            type: "set_timer",
            delayMs: TASK_CHECKIN_MS,
            event: { type: "task_checkin", sessionId, taskId },
        }]
        if (shouldAlert) {
            const mins = Math.round((now - orphanedSince) / 60000)
            effects.push(sendEffect(
                taskReplyTo(core, task, chatId, "task-checkin/orphan"),
                (defining
                    ? `*${taskId}* lost the session that was defining it (\`${sessionId}\`) ${formatDuration(mins)} ago, before the definition was locked. `
                    : `*${taskId}* lost its worker session (\`${sessionId}\`) and has made no progress for ${formatDuration(mins)}. `) +
                `No session is bound to this topic to hand it to.\n\n` +
                `Run /refresh to spawn one (the task moves over automatically), ` +
                `/task_status_${taskId} to inspect it, or /task_cancel_${taskId} to close it out.`,
                { parse_mode: "Markdown" },
            ))
        }
        return {
            stateChanges: {
                specialData: {
                    longTaskByChatId: {
                        [chatId]: {
                            [taskId]: {
                                orphanedSince,
                                ...(shouldAlert ? { orphanAlertedAt: now, orphanAlertCount: alertCount + 1 } : {}),
                            },
                        },
                    },
                },
            },
            effects,
        }
    }

    // Rate-limit: at most one check-in per 20 min. Suppressed fires return
    // null WITHOUT rescheduling, so stacked/duplicate timers drain away and
    // only the firing path keeps the chain alive. This also tames timers
    // that were already scheduled before this gate existed — they fire, hit
    // the gate, and stop multiplying. This gate is the ONLY early return
    // past this point: every fire that clears it reschedules (below), so
    // the watchdog stays alive for the whole life of an in_progress task.
    if (task.lastCheckinAt && (now - task.lastCheckinAt) < MIN_CHECKIN_INTERVAL_MS) {
        const agoMin = Math.round((now - task.lastCheckinAt) / 60000)
        dbg("TASK-CHECKIN", `check-in for ${taskId}: last was ${agoMin}m ago (<20m) — suppressing, not rescheduling`)
        return null
    }

    // Decide what to say (if anything) based on where the task is. Whatever
    // we decide, we ALWAYS reschedule and bump lastCheckinAt below — the
    // watchdog must never die while the task is in_progress. report.md
    // existing does NOT end the watchdog: the critic only runs on the
    // worker's Stop, so a worker that wrote report.md then went idle
    // mid-turn would otherwise sit forever done-but-unverified with nothing
    // to advance it (this stalled a task ~4h before this fix).
    const sessionPatch = {
        longTaskByChatId: {
            [chatId]: {
                [taskId]: {
                    lastCheckinAt: now,
                    // A worker that is back resets the orphan episode
                    // entirely, count included — the next stall should
                    // alert at 30 min, not inherit a spent backoff.
                    orphanedSince: undefined,
                    orphanAlertedAt: undefined,
                    orphanAlertCount: undefined,
                },
            },
        },
    }
    const stateChanges = { specialData: sessionPatch }
    let nudgeText = null

    if (defining) {
        // A drafting worker that ends its turn having asked the user a
        // question is behaving correctly, so there is nothing to nudge on
        // a Stop — which is why hook-stop just keeps taskCheck pending
        // here. But "waiting on the user" and "forgot this task exists"
        // look identical from outside, and only one of them is fine after
        // half an hour. So prod it on the slow clock instead.
        dbg("TASK-CHECKIN", `30min check-in nudge for ${taskId} on ${sessionId} (still defining)`)
        nudgeText = definingNudgeText(taskId, chatId)
    } else if (reportMdExists(taskId)) {
        if (core.activeCritics?.has(taskId)) {
            // Critic is already reviewing — stay quiet, just keep the
            // watchdog alive so we resume nudging if the critic finishes
            // and hands back (e.g. revisions_requested).
            dbg("TASK-CHECKIN", `check-in for ${taskId}: report.md exists, critic in flight — staying alive, no nudge`)
        } else {
            // Report written but no critic picked it up. Re-arm the session
            // so the next Stop spawns the critic, and prod the worker to end
            // its turn so that Stop actually happens.
            dbg("TASK-CHECKIN", `check-in for ${taskId}: report.md exists, no critic — prompting worker to end turn`)
            stateChanges.chatSessions = { [sessionId]: { pendingNudgeAction: "taskCheck" } }
            nudgeText = reportStalledNudgeText(chatId)
        }
    } else {
        dbg("TASK-CHECKIN", `30min check-in nudge for ${taskId} on ${sessionId}`)
        nudgeText = checkinNudgeText(taskId, chatId)
    }

    const effects = []
    if (nudgeText) {
        effects.push({ type: "send_text_to_claude", sessionId, text: nudgeText })
    }
    // Reschedule the next check-in — unconditional past the rate-limit gate.
    effects.push({
        type: "set_timer",
        delayMs: TASK_CHECKIN_MS,
        event: { type: "task_checkin", sessionId, taskId },
    })

    return { stateChanges, effects }
}
