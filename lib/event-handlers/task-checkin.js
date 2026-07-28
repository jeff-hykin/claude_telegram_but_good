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

const TASK_CHECKIN_MS = 30 * 60 * 1000

// Hard floor on check-in cadence. set_timer can't be cancelled and a
// check-in is (re)scheduled from several places (in_progress start, user
// messages, report.md, other nudges, and its own reschedule), so many
// timers stack up and all come due together — spamming the worker. This
// gate (against the task's lastCheckinAt) guarantees at most one check-in
// per 20 min no matter how many timers pile up. Suppressed fires do NOT
// reschedule, so the stack collapses back to a single self-sustaining timer.
const MIN_CHECKIN_INTERVAL_MS = 20 * 60 * 1000

function chatIdLine(chatId) {
    return chatId ? ` The Telegram chat_id for this conversation is ${chatId} — pass it to the reply tool.` : ""
}

function checkinNudgeText(chatId) {
    return `[automated check-in] It's been 30 minutes since your last check-in. Please briefly report your progress — what you've done, what's running, and what's next. If you're done, write report.md.` + chatIdLine(chatId)
}

// Sent when report.md already exists but no critic has picked it up. The
// reviewer (critic) only spawns when the worker ends its turn (Stop hook),
// so a worker that wrote report.md and then went idle mid-turn leaves the
// task wedged: done-but-unverified, with nothing to advance it. This nudge
// prompts the worker to end its turn so the critic runs.
function reportStalledNudgeText(chatId) {
    return `[automated check-in] report.md exists for this task but the reviewer hasn't run yet. The reviewer only starts when you end your turn. If you believe you're done, end your turn now so it can evaluate your report. If you're still working, keep going and rewrite report.md when finished.` + chatIdLine(chatId)
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

    const session = core.chatSessions?.[sessionId]
    if (!session) {
        dbg("TASK-CHECKIN", `session ${sessionId} gone — skipping`)
        return null
    }

    // Only fire if the session still owns this task and it's in_progress.
    if (session.longTaskId !== taskId) {
        dbg("TASK-CHECKIN", `session ${sessionId} no longer owns ${taskId} — skipping`)
        return null
    }

    const chatId = findChatIdForTask(core, taskId)
    const task = chatId ? core.specialData?.longTaskByChatId?.[chatId]?.[taskId] : null
    if (!task || task.state !== "in_progress") {
        dbg("TASK-CHECKIN", `task ${taskId} not in_progress (state=${task?.state}) — skipping`)
        return null
    }

    // Rate-limit: at most one check-in per 20 min. Suppressed fires return
    // null WITHOUT rescheduling, so stacked/duplicate timers drain away and
    // only the firing path keeps the chain alive. This also tames timers
    // that were already scheduled before this gate existed — they fire, hit
    // the gate, and stop multiplying. This gate is the ONLY early return
    // past this point: every fire that clears it reschedules (below), so
    // the watchdog stays alive for the whole life of an in_progress task.
    const now = event.ts ?? Date.now()
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
    const sessionPatch = { longTaskByChatId: { [chatId]: { [taskId]: { lastCheckinAt: now } } } }
    const stateChanges = { specialData: sessionPatch }
    let nudgeText = null

    if (reportMdExists(taskId)) {
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
        nudgeText = checkinNudgeText(chatId)
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
