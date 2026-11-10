// tests/long-task-ownership-test.js
//
// Regression tests for the 2026-11-09 incident: a stale critic verdict
// wiped the owner pointer of the task that was actually running, which
// detached it from every nudge and check-in for six hours in silence.
//
// Three properties are pinned here:
//   1. nothing releases a worker session from a task it no longer owns
//   2. a task that loses its worker is handed to its topic's successor
//   3. a task that cannot be handed over keeps saying so

import { assertEquals, assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, makeCore, effectsOfType, get, paths } from "./_helpers.js"

setupTempPaths("cbg-task-ownership-test-")

const critic = (await import("../lib/event-handlers/critic-verdict.js")).default
const checkin = (await import("../lib/event-handlers/task-checkin.js")).default
const register = (await import("../lib/event-handlers/session-register.js")).default
const { buildCancelAction } = await import("../lib/long-task-actions.js")
const {
    sessionOwnsTask,
    buildWorkerReleasePatch,
    findRehomeCandidate,
    resolveRehome,
    describeRehomeBlock,
    findTasksAwaitingThread,
    taskReplyTo,
    isLiveTaskState,
} = await import("../lib/pure/long-task-ownership.js")

const HOUR = 60 * 60 * 1000

function task(overrides = {}) {
    return {
        id: "TaskA",
        title: "a task",
        originalPrompt: "do it",
        threadId: 77,
        createdAt: "2026-11-09T08:00:00Z",
        state: "in_progress",
        workerSessionId: "Worker",
        definition: "# done",
        consecutiveIdleStops: 0,
        totalNudges: 0,
        criticCallCount: 0,
        ...overrides,
    }
}

/** A core with one task in chat 42 and whatever sessions / topic map. */
function coreWith({ tasks = [task()], sessions = {}, cc = {} } = {}) {
    const byId = {}
    for (const t of tasks) { byId[t.id] = t }
    return makeCore({
        chatSessions: sessions,
        chatState: {
            commandCenter: {
                chatId: "42",
                topicMap: {},
                threadMap: {},
                ...cc,
            },
        },
        specialData: { longTaskByChatId: { "42": byId } },
    })
}

// ── 1. ownership gate ───────────────────────────────────────────────

Deno.test("ownership: sessionOwnsTask only when the session's pointer matches", () => {
    const core = coreWith({ sessions: { Worker: { id: "Worker", longTaskId: "TaskA" } } })
    assert(sessionOwnsTask(core, "Worker", "TaskA"))
    assertEquals(sessionOwnsTask(core, "Worker", "TaskB"), false)
    assertEquals(sessionOwnsTask(core, "Ghost", "TaskA"), false)
    assertEquals(sessionOwnsTask(core, null, "TaskA"), false)
    assertEquals(sessionOwnsTask(core, "Worker", null), false)
})

Deno.test("ownership: release patch is a no-op when the session moved on", () => {
    const core = coreWith({ sessions: { Worker: { id: "Worker", longTaskId: "TaskB" } } })
    assertEquals(buildWorkerReleasePatch(core, "Worker", "TaskA"), {})
    // ...and the extra fields are gated too, not applied on their own.
    assertEquals(buildWorkerReleasePatch(core, "Worker", "TaskA", { status: "idle" }), {})
})

Deno.test("ownership: release patch frees the session that still owns the task", () => {
    const core = coreWith({ sessions: { Worker: { id: "Worker", longTaskId: "TaskA" } } })
    const patch = buildWorkerReleasePatch(core, "Worker", "TaskA", { status: "idle" })
    assertEquals(patch.chatSessions.Worker, {
        longTaskId: undefined,
        pendingNudgeAction: "none",
        status: "idle",
    })
})

// THE incident, as a test. 2026-11-09: PatientPheasant was cancelled,
// LegislativeParakeet started PremierThrush, then PatientPheasant's
// certified verdict landed 16ms later and cleared the pointer to
// PremierThrush. The successor was never nudged once in six hours.
Deno.test("critic: a stale certified verdict does not clear the successor task's pointer", () => {
    const core = coreWith({
        tasks: [
            task({ id: "PatientPheasant", state: "cancelled", workerSessionId: "LegislativeParakeet" }),
            task({ id: "PremierThrush", workerSessionId: "LegislativeParakeet" }),
        ],
        sessions: {
            LegislativeParakeet: {
                id: "LegislativeParakeet",
                longTaskId: "PremierThrush",
                pendingNudgeAction: "taskCheck",
            },
        },
    })
    const action = critic({
        taskId: "PatientPheasant",
        chatId: "42",
        verdict: "certified",
        elapsedMs: 1000,
    }, core)

    // The retired task still leaves the hot set...
    assertEquals(get(action, "stateChanges.specialData.longTaskByChatId.42.PatientPheasant"), undefined)
    // ...but the live task keeps its worker.
    assertEquals(get(action, "stateChanges.chatSessions"), undefined)
})

Deno.test("critic: certified still frees the worker when it does own the task", () => {
    const core = coreWith({
        sessions: { Worker: { id: "Worker", longTaskId: "TaskA", pendingNudgeAction: "taskCheck" } },
    })
    const action = critic({ taskId: "TaskA", chatId: "42", verdict: "certified", elapsedMs: 1 }, core)
    assertEquals(get(action, "stateChanges.chatSessions.Worker.longTaskId"), undefined)
    assertEquals(get(action, "stateChanges.chatSessions.Worker.pendingNudgeAction"), "none")
})

Deno.test("critic: escalation does not clear the successor task's pointer either", () => {
    const core = coreWith({
        tasks: [task({ id: "Old" }), task({ id: "New" })],
        sessions: { Worker: { id: "Worker", longTaskId: "New" } },
    })
    const action = critic({
        taskId: "Old",
        chatId: "42",
        verdict: "error",
        attempt: 3,
        details: "boom",
    }, core)
    assertEquals(get(action, "stateChanges.specialData.longTaskByChatId.42.Old.state"), "escalated")
    assertEquals(get(action, "stateChanges.chatSessions"), undefined)
})

Deno.test("cancel: a late cancel does not idle a session that moved on", () => {
    const core = coreWith({
        tasks: [task({ id: "Old" }), task({ id: "New" })],
        sessions: { Worker: { id: "Worker", longTaskId: "New", status: "working" } },
    })
    const { ok, action } = buildCancelAction(core, "42", "Old")
    assert(ok)
    assertEquals(get(action, "stateChanges.specialData.longTaskByChatId.42.Old.state"), "cancelled")
    assertEquals(action.stateChanges.chatSessions, undefined)
})

Deno.test("cancel: still releases the worker that owns the cancelled task", () => {
    const core = coreWith({ sessions: { Worker: { id: "Worker", longTaskId: "TaskA", status: "working" } } })
    const { ok, action } = buildCancelAction(core, "42", "TaskA")
    assert(ok)
    assertEquals(action.stateChanges.chatSessions.Worker, {
        longTaskId: undefined,
        pendingNudgeAction: "none",
        status: "idle",
    })
})

// ── 2. re-homing ────────────────────────────────────────────────────

Deno.test("rehome: candidate is the session now bound to the task's topic", () => {
    const core = coreWith({
        sessions: { Heir: { id: "Heir" } },
        cc: { threadMap: { "77": "Heir" } },
    })
    assertEquals(findRehomeCandidate(core, task(), "TaskA"), "Heir")
})

Deno.test("rehome: no candidate when the topic's session is busy, absent, or unchanged", () => {
    const busy = coreWith({
        sessions: { Heir: { id: "Heir", longTaskId: "Other" } },
        cc: { threadMap: { "77": "Heir" } },
    })
    assertEquals(findRehomeCandidate(busy, task(), "TaskA"), null)

    const notConnected = coreWith({ cc: { threadMap: { "77": "Heir" } } })
    assertEquals(findRehomeCandidate(notConnected, task(), "TaskA"), null)

    const sameSession = coreWith({
        sessions: { Worker: { id: "Worker" } },
        cc: { threadMap: { "77": "Worker" } },
    })
    assertEquals(findRehomeCandidate(sameSession, task(), "TaskA"), null)

    const noThread = coreWith({ sessions: { Heir: { id: "Heir" } } })
    assertEquals(findRehomeCandidate(noThread, task({ threadId: null }), "TaskA"), null)
})

Deno.test("rehome: the blocked reason distinguishes an empty topic from a busy one", () => {
    const busy = coreWith({
        sessions: { Heir: { id: "Heir", longTaskId: "Other" } },
        cc: { threadMap: { "77": "Heir" } },
    })
    assertEquals(resolveRehome(busy, task(), "TaskA"), {
        heirId: null,
        reason: "session-busy",
        candidateId: "Heir",
        blockingTaskId: "Other",
    })

    const notConnected = coreWith({ cc: { threadMap: { "77": "Heir" } } })
    assertEquals(resolveRehome(notConnected, task(), "TaskA"), {
        heirId: null,
        reason: "session-gone",
        candidateId: "Heir",
    })

    const empty = coreWith({ sessions: { Worker: { id: "Worker" } }, cc: { threadMap: { "77": "Worker" } } })
    assertEquals(resolveRehome(empty, task(), "TaskA").reason, "no-session")

    const noThread = coreWith({ sessions: { Heir: { id: "Heir" } } })
    assertEquals(resolveRehome(noThread, task({ threadId: null }), "TaskA").reason, "no-thread")
})

Deno.test("rehome: a busy topic is never told to /refresh — that would kill the live worker", () => {
    const busy = coreWith({
        sessions: { Heir: { id: "Heir", longTaskId: "Other" } },
        cc: { threadMap: { "77": "Heir" } },
    })
    const { blocker, advice } = describeRehomeBlock(resolveRehome(busy, task(), "TaskA"), "TaskA")
    assertStringIncludes(blocker, "Heir")
    assertStringIncludes(blocker, "Other")
    assert(!blocker.includes("No session is bound"))
    assert(!advice.includes("/refresh"))
    assertStringIncludes(advice, "/task_cancel_TaskA")

    const empty = coreWith({ sessions: { Worker: { id: "Worker" } }, cc: { threadMap: { "77": "Worker" } } })
    assertStringIncludes(describeRehomeBlock(resolveRehome(empty, task(), "TaskA"), "TaskA").advice, "/refresh")
})

Deno.test("rehome: a task with no recorded threadId falls back to its worker's topic", () => {
    const core = coreWith({
        sessions: { Heir: { id: "Heir" }, Worker: { id: "Worker" } },
        cc: { topicMap: { Worker: "77" }, threadMap: { "77": "Heir" } },
    })
    assertEquals(findRehomeCandidate(core, task({ threadId: undefined }), "TaskA"), "Heir")
})

Deno.test("checkin: an orphaned task is handed to its topic's successor", () => {
    const core = coreWith({
        sessions: { Heir: { id: "Heir" } },
        cc: { threadMap: { "77": "Heir" } },
    })
    const action = checkin({ sessionId: "Worker", taskId: "TaskA", ts: Date.now() }, core)

    assertEquals(get(action, "stateChanges.specialData.longTaskByChatId.42.TaskA.workerSessionId"), "Heir")
    assertEquals(get(action, "stateChanges.chatSessions.Heir.longTaskId"), "TaskA")
    assertEquals(get(action, "stateChanges.chatSessions.Heir.pendingNudgeAction"), "taskCheck")
    // Orphan markers reset so a later stall alerts from scratch.
    assertEquals(get(action, "stateChanges.specialData.longTaskByChatId.42.TaskA.orphanedSince"), undefined)
    assertEquals(get(action, "stateChanges.specialData.longTaskByChatId.42.TaskA.orphanAlertCount"), undefined)

    // The heir is told where to pick the work up...
    const delivered = effectsOfType(action, "deliver_channel_event")
    assertEquals(delivered.length, 1)
    assertEquals(delivered[0].sessionId, "Heir")
    assert(delivered[0].content.includes(paths.longTaskDir("TaskA")))
    // ...a new check-in chain is armed for it...
    const timers = effectsOfType(action, "set_timer")
    assertEquals(timers.length, 1)
    assertEquals(timers[0].event.sessionId, "Heir")
    // ...and the user hears about it, in the task's own topic.
    const sent = effectsOfType(action, "send_text_to_user")
    assertEquals(sent.length, 1)
    assertEquals(sent[0].replyTo.threadId, 77)
    assertEquals(effectsOfType(action, "cold_append")[0].entry.event, "rehomed")
})

Deno.test("checkin: the old worker's pointer is left alone when re-homing", () => {
    // It either no longer exists or is already busy with another task —
    // which is exactly why we're re-homing. Touching it is the original bug.
    const core = coreWith({
        sessions: {
            Worker: { id: "Worker", longTaskId: "SomethingElse" },
            Heir: { id: "Heir" },
        },
        cc: { threadMap: { "77": "Heir" } },
    })
    const action = checkin({ sessionId: "Worker", taskId: "TaskA", ts: Date.now() }, core)
    assertEquals(get(action, "stateChanges.chatSessions.Worker"), undefined)
    assertEquals(get(action, "stateChanges.chatSessions.Heir.longTaskId"), "TaskA")
})

Deno.test("register: a session inheriting a topic wakes the orphaned task's check-in", () => {
    const core = coreWith({
        cc: { threadMap: { "77": "Heir" } },
    })
    const action = register({
        session: { id: "Heir", pid: 0, cwd: "/tmp", title: "t" },
        ts: Date.now(),
        _conn: null,
    }, core)
    const woken = (action.followUpEvents ?? []).filter(e => e.type === "task_checkin")
    assertEquals(woken.length, 1)
    assertEquals(woken[0].taskId, "TaskA")
    // Addressed to the DEAD worker on purpose: that's the chain identity
    // task-checkin validates before it re-homes.
    assertEquals(woken[0].sessionId, "Worker")
})

Deno.test("register: no wake-up when the topic's task still has a live owner", () => {
    const core = coreWith({
        sessions: { Worker: { id: "Worker", longTaskId: "TaskA" } },
        cc: { threadMap: { "77": "Heir" } },
    })
    const action = register({
        session: { id: "Heir", pid: 0, cwd: "/tmp", title: "t" },
        ts: Date.now(),
        _conn: null,
    }, core)
    assertEquals((action.followUpEvents ?? []).filter(e => e.type === "task_checkin").length, 0)
})

Deno.test("awaiting-thread: only in_progress tasks of that thread, minus live ones", () => {
    const core = coreWith({
        tasks: [
            task({ id: "Live", workerSessionId: "Busy" }),
            task({ id: "Orphan" }),
            task({ id: "Done", state: "certified" }),
            task({ id: "Elsewhere", threadId: 99 }),
        ],
        sessions: { Busy: { id: "Busy", longTaskId: "Live" } },
    })
    const found = findTasksAwaitingThread(core, "77", "Heir").map(x => x.taskId)
    assertEquals(found, ["Orphan"])
})

// ── 3. alerting when it cannot be fixed ─────────────────────────────

Deno.test("checkin: orphan alert lands in the task's topic, not the group's General", () => {
    // No session bound to the topic, so nothing to hand it to.
    const core = coreWith()
    const now = Date.now()
    const action = checkin({ sessionId: "Worker", taskId: "TaskA", ts: now }, core)
    // First fire only records orphanedSince — the alert waits 30 min.
    assertEquals(effectsOfType(action, "send_text_to_user").length, 0)
    assertEquals(get(action, "stateChanges.specialData.longTaskByChatId.42.TaskA.orphanedSince"), now)

    const later = checkin(
        { sessionId: "Worker", taskId: "TaskA", ts: now + 31 * 60 * 1000 },
        coreWith({ tasks: [task({ orphanedSince: now })] }),
    )
    const sent = effectsOfType(later, "send_text_to_user")
    assertEquals(sent.length, 1)
    assertEquals(sent[0].replyTo.chatId, "42")
    assertEquals(sent[0].replyTo.threadId, 77)
    assertEquals(get(later, "stateChanges.specialData.longTaskByChatId.42.TaskA.orphanAlertCount"), 1)
})

Deno.test("checkin: orphan alerts repeat on a widening gap instead of going silent", () => {
    const t0 = Date.now()
    // Already alerted once, 45 min ago. Second gap is 1h, so: not yet.
    const quiet = checkin(
        { sessionId: "Worker", taskId: "TaskA", ts: t0 },
        coreWith({ tasks: [task({ orphanedSince: t0 - 2 * HOUR, orphanAlertedAt: t0 - 45 * 60 * 1000, orphanAlertCount: 1 })] }),
    )
    assertEquals(effectsOfType(quiet, "send_text_to_user").length, 0)
    // Nothing recorded, so the clock isn't reset by a quiet fire.
    assertEquals(get(quiet, "stateChanges.specialData.longTaskByChatId.42.TaskA.orphanAlertedAt"), undefined)

    // Same state, 70 min after the last alert: due.
    const loud = checkin(
        { sessionId: "Worker", taskId: "TaskA", ts: t0 },
        coreWith({ tasks: [task({ orphanedSince: t0 - 3 * HOUR, orphanAlertedAt: t0 - 70 * 60 * 1000, orphanAlertCount: 1 })] }),
    )
    assertEquals(effectsOfType(loud, "send_text_to_user").length, 1)
    assertEquals(get(loud, "stateChanges.specialData.longTaskByChatId.42.TaskA.orphanAlertCount"), 2)
    // The message says how long it has been stuck, in hours.
    assert(effectsOfType(loud, "send_text_to_user")[0].text.includes("3h"))
})

Deno.test("checkin: the orphan alert gap is capped so it never goes quiet for a whole night", () => {
    const t0 = Date.now()
    // alertCount 9 would be 30min * 2^9 = 256h without the cap.
    const action = checkin(
        { sessionId: "Worker", taskId: "TaskA", ts: t0 },
        coreWith({ tasks: [task({ orphanedSince: t0 - 20 * HOUR, orphanAlertedAt: t0 - 2.5 * HOUR, orphanAlertCount: 9 })] }),
    )
    assertEquals(effectsOfType(action, "send_text_to_user").length, 1)
})

Deno.test("checkin: an orphaned task keeps its watchdog timer alive", () => {
    const core = coreWith()
    const action = checkin({ sessionId: "Worker", taskId: "TaskA", ts: Date.now() }, core)
    const timers = effectsOfType(action, "set_timer")
    assertEquals(timers.length, 1)
    assertEquals(timers[0].event, { type: "task_checkin", sessionId: "Worker", taskId: "TaskA" })
})

// ── 4. the defining phase is watched too ────────────────────────────

Deno.test("defining: a drafting task is a live task", () => {
    assert(isLiveTaskState("defining"))
    assert(isLiveTaskState("in_progress"))
    for (const dead of ["cancelled", "certified", "escalated", undefined]) {
        assertEquals(isLiveTaskState(dead), false)
    }
})

Deno.test("defining: a task frozen mid-draft keeps its watchdog instead of dropping it", () => {
    // Before this, task-checkin returned null for anything but
    // in_progress — so a task whose worker died while drafting had no
    // timer, no alert and no way back.
    const core = coreWith({ tasks: [task({ state: "defining" })] })
    const action = checkin({ sessionId: "Worker", taskId: "TaskA", ts: Date.now() }, core)
    assert(action, "a defining task must not drop its check-in chain")
    assertEquals(effectsOfType(action, "set_timer").length, 1)
})

Deno.test("defining: a drafting task with a live worker gets prodded, not left waiting", () => {
    const core = coreWith({
        tasks: [task({ state: "defining" })],
        sessions: { Worker: { id: "Worker", longTaskId: "TaskA" } },
    })
    const action = checkin({ sessionId: "Worker", taskId: "TaskA", ts: Date.now() }, core)
    const nudges = effectsOfType(action, "send_text_to_claude")
    assertEquals(nudges.length, 1)
    assert(nudges[0].text.includes("submit_long_task_definition"))
    assert(nudges[0].text.includes("defining"))
    // Never the in_progress script — there is no progress.md to write yet.
    assertEquals(nudges[0].text.includes("progress.md ("), false)
    assertEquals(effectsOfType(action, "set_timer").length, 1)
})

Deno.test("defining: an orphaned draft re-homes with the original request, not progress.md", () => {
    const core = coreWith({
        tasks: [task({ state: "defining", originalPrompt: "port the FAR planner" })],
        sessions: { Heir: { id: "Heir" } },
        cc: { threadMap: { "77": "Heir" } },
    })
    const action = checkin({ sessionId: "Worker", taskId: "TaskA", ts: Date.now() }, core)
    assertEquals(get(action, "stateChanges.specialData.longTaskByChatId.42.TaskA.workerSessionId"), "Heir")
    const handoff = effectsOfType(action, "deliver_channel_event")[0].content
    assert(handoff.includes("port the FAR planner"), "heir must be given the original request")
    assert(handoff.includes("submit_long_task_definition"))
    // Nothing exists to pick up from, so it must not claim otherwise.
    assertEquals(handoff.includes("progress.md, and the definition"), false)
    assertEquals(effectsOfType(action, "cold_append")[0].entry.state, "defining")
})

Deno.test("defining: a stranded draft with no successor still alerts", () => {
    const now = Date.now()
    const core = coreWith({ tasks: [task({ state: "defining", orphanedSince: now - 40 * 60 * 1000 })] })
    const action = checkin({ sessionId: "Worker", taskId: "TaskA", ts: now }, core)
    const sent = effectsOfType(action, "send_text_to_user")
    assertEquals(sent.length, 1)
    assertEquals(sent[0].replyTo.threadId, 77)
    assert(sent[0].text.includes("defining it"), "the alert must say the definition was never locked")
})

Deno.test("defining: /task arms the check-in chain at creation", async () => {
    // The chain used to start only when the definition was locked, which
    // is precisely the step a dead drafting worker never reaches.
    const chatUser = (await import("../lib/event-handlers/chat-user.js")).default
    const core = makeCore({
        chatState: { focusedSessionId: "Worker", commandCenter: { chatId: "42" } },
        chatSessions: { Worker: { id: "Worker", _conn: {} } },
        specialData: { longTaskByChatId: {} },
    })
    const action = await chatUser({
        type: "chat_user_message",
        chatId: "42",
        text: "/task port the FAR planner",
        ts: Date.now(),
        messageId: 1,
        userId: 1,
    }, core)
    const armed = effectsOfType(action, "set_timer").filter(e => e.event?.type === "task_checkin")
    assertEquals(armed.length, 1)
    assertEquals(armed[0].event.sessionId, "Worker")
})

// ── routing ─────────────────────────────────────────────────────────

Deno.test("routing: taskReplyTo prefers the task's own thread over its dead worker", () => {
    const core = coreWith({ cc: { chatId: "42", topicMap: {}, threadMap: {} } })
    const rt = taskReplyTo(core, task(), "42", "test")
    assertEquals(rt.chatId, "42")
    assertEquals(rt.threadId, 77)
})

Deno.test("routing: taskReplyTo falls back to the worker for tasks with no threadId", () => {
    const core = coreWith({
        sessions: { Worker: { id: "Worker" } },
        cc: { chatId: "42", topicMap: { Worker: "88" }, threadMap: { "88": "Worker" } },
    })
    const rt = taskReplyTo(core, task({ threadId: null }), "42", "test")
    assertEquals(rt.threadId, 88)
})
