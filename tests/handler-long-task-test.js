// tests/handler-long-task-test.js
//
// Unit tests for long-task-definition-submitted and critic-verdict.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, makeCore, fakeConn, effectsOfType, get } from "./_helpers.js"

setupTempPaths("cbg-longtask-test-")

const submit = (await import("../lib/event-handlers/long-task-definition-submitted.js")).default
const critic = (await import("../lib/event-handlers/critic-verdict.js")).default

function baseTask(overrides = {}) {
    return {
        id: "t1",
        title: "do thing",
        originalPrompt: "do thing",
        createdAt: "2026-04-12T00:00:00Z",
        state: "defining",
        workerSessionId: "worker",
        definition: null,
        consecutiveIdleStops: 0,
        totalNudges: 0,
        criticCallCount: 0,
        ...overrides,
    }
}

function coreWithTask(task, chatId = "42") {
    return makeCore({
        specialData: {
            longTaskByChatId: {
                [chatId]: { [task.id]: task },
            },
        },
    })
}

// ── long-task-definition-submitted ──────────────────────────────────

Deno.test("long-task-submit: invalid event rejects with error", () => {
    const core = coreWithTask(baseTask())
    const action = submit({
        taskId: "t1",
        definition: "",
        sessionId: "worker",
        requestId: "r1",
        _conn: fakeConn(),
    }, core)
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc[0].message.result.isError, true)
})

Deno.test("long-task-submit: unknown task returns an error", () => {
    const core = coreWithTask(baseTask())
    const action = submit({
        taskId: "ghost",
        definition: "# done",
        sessionId: "worker",
        requestId: "r1",
        _conn: fakeConn(),
    }, core)
    assert(effectsOfType(action, "ipc_respond")[0].message.result.isError)
})

Deno.test("long-task-submit: session mismatch rejects", () => {
    const core = coreWithTask(baseTask())
    const action = submit({
        taskId: "t1",
        definition: "# done",
        sessionId: "someone-else",
        requestId: "r1",
        _conn: fakeConn(),
    }, core)
    assert(effectsOfType(action, "ipc_respond")[0].message.result.isError)
})

Deno.test("long-task-submit: wrong state (not 'defining') rejects", () => {
    const core = coreWithTask(baseTask({ state: "in_progress" }))
    const action = submit({
        taskId: "t1",
        definition: "# done",
        sessionId: "worker",
        requestId: "r1",
        _conn: fakeConn(),
    }, core)
    assert(effectsOfType(action, "ipc_respond")[0].message.result.isError)
})

Deno.test("long-task-submit: happy path locks the definition and transitions to in_progress", () => {
    const core = coreWithTask(baseTask())
    const action = submit({
        taskId: "t1",
        definition: "# done criteria",
        sessionId: "worker",
        requestId: "r1",
        _conn: fakeConn(),
    }, core)
    const patch = get(action, "stateChanges.specialData.longTaskByChatId.42.t1")
    assertEquals(patch.state, "in_progress")
    assertEquals(patch.definition, "# done criteria")
    // Reply is success (no isError)
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc[0].message.result.isError, undefined)
    // Cold-storage trail
    assertEquals(effectsOfType(action, "cold_append")[0].entry.event, "definition_locked")
})

Deno.test("long-task-submit: already-submitted rejects", () => {
    const core = coreWithTask(baseTask({ definition: "already set" }))
    const action = submit({
        taskId: "t1",
        definition: "# new",
        sessionId: "worker",
        requestId: "r1",
        _conn: fakeConn(),
    }, core)
    assert(effectsOfType(action, "ipc_respond")[0].message.result.isError)
})

// ── critic-verdict ──────────────────────────────────────────────────

Deno.test("critic: certified notifies worker + drops task from hot set", () => {
    const core = coreWithTask(baseTask({ state: "in_progress", definition: "x" }))
    const action = critic({
        taskId: "t1",
        chatId: "42",
        verdict: "certified",
        elapsedMs: 1234,
    }, core)
    assertEquals(get(action, "stateChanges.specialData.longTaskByChatId.42.t1"), undefined)
    const toClaude = effectsOfType(action, "send_text_to_claude")
    assertEquals(toClaude.length, 1)
    assertEquals(toClaude[0].sessionId, "worker")
    assertEquals(effectsOfType(action, "cold_append")[0].entry.event, "certified")
})

Deno.test("critic: revisions tells worker to read revisions.md and flips state to in_progress", () => {
    const core = coreWithTask(baseTask({ state: "in_progress", definition: "x" }))
    const action = critic({
        taskId: "t1",
        chatId: "42",
        verdict: "revisions",
        attempt: 1,
    }, core)
    const patch = get(action, "stateChanges.specialData.longTaskByChatId.42.t1")
    assertEquals(patch.state, "in_progress")
    assertEquals(patch.consecutiveIdleStops, 0)
    const toClaude = effectsOfType(action, "send_text_to_claude")
    assert(toClaude[0].text.includes("requested_revisions.md"))
})

Deno.test("critic: anomaly verdict is logged distinctly but otherwise same as revisions", () => {
    const core = coreWithTask(baseTask({ state: "in_progress", definition: "x" }))
    const action = critic({
        taskId: "t1",
        chatId: "42",
        verdict: "anomaly",
        attempt: 2,
    }, core)
    assertEquals(effectsOfType(action, "cold_append")[0].entry.event, "revisions_requested_anomaly")
})

Deno.test("critic: clarification_needed asks the user and flips state", () => {
    const core = coreWithTask(baseTask({ state: "in_progress", definition: "x" }))
    const action = critic({
        taskId: "t1",
        chatId: "42",
        verdict: "clarification_needed",
    }, core)
    assertEquals(
        get(action, "stateChanges.specialData.longTaskByChatId.42.t1.state"),
        "awaiting_clarification",
    )
    assertEquals(effectsOfType(action, "send_text_to_user").length, 1)
})

Deno.test("critic: indecisive retry-eligible verdict spawns another critic under 3 attempts", () => {
    const core = coreWithTask(baseTask({ state: "in_progress", definition: "x" }))
    const action = critic({
        taskId: "t1",
        chatId: "42",
        verdict: "indecisive",
        attempt: 1,
    }, core)
    const spawns = effectsOfType(action, "spawn_critic")
    assertEquals(spawns.length, 1)
    assertEquals(spawns[0].attempt, 2)
    assertEquals(effectsOfType(action, "send_text_to_user").length, 0)
})

Deno.test("critic: indecisive at attempt 3 escalates to the user", () => {
    const core = coreWithTask(baseTask({ state: "in_progress", definition: "x" }))
    const action = critic({
        taskId: "t1",
        chatId: "42",
        verdict: "error",
        details: "spawn failed",
        attempt: 3,
    }, core)
    assertEquals(effectsOfType(action, "spawn_critic").length, 0)
    assertEquals(effectsOfType(action, "send_text_to_user").length, 1)
    assertEquals(effectsOfType(action, "cold_append")[0].entry.event, "critic_escalated")
})

Deno.test("critic: escalation transitions task state to 'escalated' (terminal)", () => {
    const core = coreWithTask(baseTask({ state: "in_progress", definition: "x" }))
    const action = critic({
        taskId: "t1",
        chatId: "42",
        verdict: "indecisive",
        details: "no verdict file",
        attempt: 3,
    }, core)
    assertEquals(
        get(action, "stateChanges.specialData.longTaskByChatId.42.t1.state"),
        "escalated",
    )
})

Deno.test("critic: dry-run just logs to cold storage", () => {
    const core = coreWithTask(baseTask({ state: "in_progress", definition: "x" }))
    const action = critic({
        taskId: "t1",
        chatId: "42",
        verdict: "dry-run",
    }, core)
    assertEquals(effectsOfType(action, "cold_append").length, 1)
    assertEquals(effectsOfType(action, "cold_append")[0].entry.event, "dry_run")
    assertEquals(effectsOfType(action, "send_text_to_claude").length, 0)
})

Deno.test("critic: verdict for orphaned task logs verdict_orphan", () => {
    const core = makeCore({ specialData: { longTaskByChatId: {} } })
    const action = critic({
        taskId: "ghost",
        chatId: "42",
        verdict: "certified",
    }, core)
    assertEquals(effectsOfType(action, "cold_append")[0].entry.event, "verdict_orphan")
})

Deno.test("critic: missing taskId is a silent no-op", () => {
    const core = makeCore()
    const action = critic({ chatId: "42", verdict: "certified" }, core)
    assertEquals(action.effects, [])
})

Deno.test("critic: unknown verdict is a silent no-op", () => {
    const core = coreWithTask(baseTask({ state: "in_progress" }))
    const action = critic({
        taskId: "t1",
        chatId: "42",
        verdict: "martian",
    }, core)
    assertEquals(action.effects, [])
})
