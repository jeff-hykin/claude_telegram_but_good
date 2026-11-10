// ---------------------------------------------------------------------------
// lib/pure/long-task-ownership.js — who owns a long task right now.
//
// A session hosts at most one long task, recorded two ways that must
// agree: `task.workerSessionId` points at the session, `session.longTaskId`
// points back at the task. Code that certifies, gives up on, or cancels a
// task wants to release the session so it can host the next one — but a
// task can reach that point LONG after the session moved on. A critic
// subprocess runs for minutes; a cancelled task's verdict can land after
// the user already started the next task.
//
// Clearing the pointer unconditionally then wipes the pointer belonging to
// the task that is actually running. Nothing crashes; the task just stops
// being nudged, checked in on, or reported, because every watchdog resolves
// the task through its worker and now sees "no longer owns it". The work
// keeps going and nobody hears about it.
//
// That cost a 6h overnight run on 2026-11-09: a cancelled task's certified
// verdict landed 16ms after the successor armed its nudge timer, and the
// successor was never nudged once in six hours.
//
// So: every release is gated on the session still owning exactly the task
// being released.
//
// The same incident exposed the other half of the problem: a task that has
// lost its worker could neither find a new one nor tell anybody, because
// both answers were looked up THROUGH the dead worker. Hence the re-home
// and routing helpers at the bottom, which go through the task's topic.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { makeReplyTo, replyToForSession } = await versionedImport("./reply-to.js", import.meta)

// Cadence of the backup check-in chain, and the single definition of it.
// Four files arm `task_checkin` timers (task creation by user, task
// creation by agent, definition locked, and the chain's own reschedule)
// and each used to carry its own copy of this number with a comment
// asking the reader to keep them in sync by hand.
export const TASK_CHECKIN_MS = 30 * 60 * 1000

// The states in which a task is somebody's current job and therefore
// needs a watchdog: it is being drafted, or it is being worked. Anything
// else (cancelled, certified, escalated) is nobody's job any more.
//
// `defining` belongs here even though it only lasts minutes. It used to
// be left out, which meant a task whose worker died mid-draft froze in
// `defining` with no timer watching it and no way back.
export const LIVE_TASK_STATES = ["defining", "in_progress"]

export function isLiveTaskState(state) {
    return LIVE_TASK_STATES.includes(state)
}

/**
 * True when `sessionId` is still the live host of `taskId`.
 *
 * Deliberately checks the session's pointer, not the task's. The task
 * record is the thing being retired; the session's pointer is the thing
 * we are about to overwrite, so it is the one that must match.
 */
export function sessionOwnsTask(core, sessionId, taskId) {
    if (!sessionId || !taskId) {
        return false
    }
    return core?.chatSessions?.[sessionId]?.longTaskId === taskId
}

/**
 * State patch that frees a worker session from a task that has been
 * certified, escalated, or cancelled.
 *
 * Returns `{}` — a no-op — unless the session still owns exactly this
 * task. `extra` carries any extra session fields the caller sets
 * alongside the release (e.g. `status: "idle"` on cancel); those are
 * gated on ownership too, because they describe the retired task's
 * worker and would otherwise stomp whatever the session is doing now.
 */
export function buildWorkerReleasePatch(core, sessionId, taskId, extra = {}) {
    if (!sessionOwnsTask(core, sessionId, taskId)) {
        return {}
    }
    return {
        chatSessions: {
            [sessionId]: {
                longTaskId: undefined,
                pendingNudgeAction: "none",
                ...extra,
            },
        },
    }
}

/**
 * The command-center thread a task belongs to, as a string key, or null.
 *
 * Tasks created since 2026-11-09 record `threadId` at creation. Older
 * ones don't, so fall back to the thread their recorded worker is bound
 * to — correct right up until that worker is replaced, which is exactly
 * when it stops being available. Hence recording it on the task.
 */
export function taskThreadKey(core, task) {
    if (task?.threadId != null) {
        return String(task.threadId)
    }
    const cc = core?.chatState?.commandCenter ?? {}
    const viaWorker = task?.workerSessionId ? cc.topicMap?.[task.workerSessionId] : null
    return viaWorker != null ? String(viaWorker) : null
}

/**
 * Why an orphaned task could not be handed to a new session — or that it
 * can be, via `heirId`.
 *
 * The reason matters because the advice differs sharply. "Nobody is in
 * this topic" means `/refresh`; "the session in this topic is busy with
 * another task" means the OPPOSITE — `/refresh` there would kill a live
 * worker. Collapsing both into one sentence (which is what the alert used
 * to do) told the user to destroy the session doing the work.
 *
 * Returns `{ heirId }` when a successor is available, otherwise
 * `{ heirId: null, reason, candidateId?, blockingTaskId? }` with `reason`
 * one of:
 *   - `no-thread`      the task has no topic and its worker is unmapped
 *   - `no-session`     nothing is bound to the topic (or only the dead worker)
 *   - `session-gone`   the bound session is not connected
 *   - `session-busy`   the bound session already hosts another task
 */
export function resolveRehome(core, task, taskId) {
    const threadKey = taskThreadKey(core, task)
    if (!threadKey) {
        return { heirId: null, reason: "no-thread" }
    }
    const cc = core?.chatState?.commandCenter ?? {}
    const candidateId = cc.threadMap?.[threadKey] ?? null
    if (!candidateId || candidateId === task?.workerSessionId) {
        return { heirId: null, reason: "no-session" }
    }
    const candidate = core?.chatSessions?.[candidateId]
    if (!candidate) {
        return { heirId: null, reason: "session-gone", candidateId }
    }
    if (candidate.longTaskId && candidate.longTaskId !== taskId) {
        return { heirId: null, reason: "session-busy", candidateId, blockingTaskId: candidate.longTaskId }
    }
    return { heirId: candidateId }
}

/**
 * The session currently bound to a task's topic — i.e. whoever `/refresh`
 * or `/new` last put there. This is the natural successor for a task whose
 * worker went away: same topic, same user-visible conversation.
 *
 * Returns null when there is no thread, nothing bound to it, the bound
 * session isn't connected, or it already hosts a different task (the
 * one-task-per-session invariant wins over auto-recovery).
 */
export function findRehomeCandidate(core, task, taskId) {
    return resolveRehome(core, task, taskId).heirId
}

/**
 * The two user-facing sentences for an orphaned task that could not be
 * re-homed: what is in the way, and what to do about it.
 *
 * Kept here, next to the resolver, so the explanation can never drift
 * from the condition that produced it. Returns `{ blocker, advice }`,
 * both Telegram-Markdown.
 */
export function describeRehomeBlock(resolution, taskId) {
    const inspect = `/task_status_${taskId} to inspect it, or /task_cancel_${taskId} to close it out.`
    const candidate = resolution?.candidateId ? `\`${resolution.candidateId}\`` : "The bound session"
    switch (resolution?.reason) {
        case "session-busy":
            return {
                blocker: `${candidate} is in this topic but is already working on ` +
                    `\`${resolution.blockingTaskId}\`, and a session hosts one task at a time.`,
                // Deliberately does NOT suggest /refresh: it would replace
                // the session that is actively working the other task.
                advice: `If this task is superseded, /task_cancel_${taskId}. Otherwise it is picked up ` +
                    `automatically once \`${resolution.blockingTaskId}\` finishes, or run ` +
                    `/task_resume_${taskId} from another topic to move it there.`,
            }
        case "session-gone":
            return {
                blocker: `${candidate} is bound to this topic but is not connected.`,
                advice: `Run /refresh to respawn it (the task moves over automatically), ${inspect}`,
            }
        case "no-thread":
            return {
                blocker: `No topic is recorded for this task, so there is nobody to hand it to.`,
                advice: `Run /task_resume_${taskId} from the topic that should pick it up, or ` +
                    `/task_cancel_${taskId} to close it out.`,
            }
        default:
            return {
                blocker: `No session is bound to this topic to hand it to.`,
                advice: `Run /refresh to spawn one (the task moves over automatically), ${inspect}`,
            }
    }
}

/**
 * Live tasks (drafting or working) belonging to `threadKey` whose recorded worker is no
 * longer hosting them — i.e. tasks a session newly bound to that topic
 * should take over.
 *
 * Used at session_register so a `/refresh` recovers the topic's task in
 * seconds instead of waiting up to 30 minutes for the next check-in.
 * Returns `[{ chatId, taskId, task }]`.
 */
export function findTasksAwaitingThread(core, threadKey, newSessionId) {
    if (threadKey == null) {
        return []
    }
    const wanted = String(threadKey)
    const out = []
    const byChat = core?.specialData?.longTaskByChatId ?? {}
    for (const [chatId, tasks] of Object.entries(byChat)) {
        for (const [taskId, task] of Object.entries(tasks ?? {})) {
            if (!task || !isLiveTaskState(task.state)) {
                continue
            }
            if (taskThreadKey(core, task) !== wanted) {
                continue
            }
            const worker = task.workerSessionId
            if (worker === newSessionId || sessionOwnsTask(core, worker, taskId)) {
                continue
            }
            out.push({ chatId, taskId, task })
        }
    }
    return out
}

/**
 * Where a message about this task goes.
 *
 * Prefers the thread recorded on the task, because that is the only
 * route that still works once the worker is gone — and "the worker is
 * gone" is precisely when we most need to say something. Falls back to
 * resolving through the worker (correct for tasks created before
 * threadId was recorded), then to the bare chat.
 */
export function taskReplyTo(core, task, chatId, setBy) {
    const threadKey = taskThreadKey(core, task)
    if (threadKey != null) {
        const cc = core?.chatState?.commandCenter ?? {}
        const resolvedChatId = cc.chatId ?? chatId
        if (resolvedChatId != null) {
            return makeReplyTo({ chatId: resolvedChatId, threadId: Number(threadKey), setBy })
        }
    }
    return replyToForSession(task?.workerSessionId, core, setBy, chatId)
}
