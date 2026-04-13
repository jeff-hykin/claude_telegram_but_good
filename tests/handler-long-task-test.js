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

Deno.test("critic: certified drops task from hot set + edits the critic status message", () => {
    const core = coreWithTask(baseTask({ state: "in_progress", definition: "x" }))
    const action = critic({
        taskId: "t1",
        chatId: "42",
        verdict: "certified",
        elapsedMs: 1234,
    }, core)
    assertEquals(get(action, "stateChanges.specialData.longTaskByChatId.42.t1"), undefined)
    // We deliberately do NOT notify the worker on certified — the bot
    // already posts its own "✅ certified" message via the edited
    // "Critic running…" bubble, and a second worker-authored summary
    // was redundant.
    assertEquals(effectsOfType(action, "deliver_channel_event").length, 0)
    assertEquals(effectsOfType(action, "send_text_to_claude").length, 0)
    assertEquals(effectsOfType(action, "cold_append")[0].entry.event, "certified")
})

Deno.test("critic: revisions tells worker to read revisions.md + re-arms taskCheck + flips state to in_progress", () => {
    const core = coreWithTask(baseTask({ state: "in_progress", definition: "x" }))
    const action = critic({
        taskId: "t1",
        chatId: "42",
        verdict: "revisions",
        attempt: 1,
        ts: 123_000,
    }, core)
    const patch = get(action, "stateChanges.specialData.longTaskByChatId.42.t1")
    assertEquals(patch.state, "in_progress")
    assertEquals(patch.consecutiveIdleStops, 0)
    // Session re-arm: without this, the next Stop after the worker's
    // revision turn would see pendingNudgeAction:"none" (cleared by
    // claude-hook-stop when the critic spawned) and silently no-op —
    // the critic cycle would never re-fire.
    const sessionPatch = get(action, "stateChanges.chatSessions.worker")
    assertEquals(sessionPatch.pendingNudgeAction, "taskCheck")
    // Notification via MCP channel, not dtach.
    const delivers = effectsOfType(action, "deliver_channel_event")
    assertEquals(delivers.length, 1)
    assertEquals(delivers[0].sessionId, "worker")
    assert(delivers[0].content.includes("requested_revisions"))
    assertEquals(effectsOfType(action, "send_text_to_claude").length, 0)
})

Deno.test("critic: revisions archives requested_revisions.md under revisions/<ts>.md and deletes old report.md", () => {
    const core = coreWithTask(baseTask({ state: "in_progress", definition: "x" }))
    const action = critic({
        taskId: "t1",
        chatId: "42",
        verdict: "revisions",
        attempt: 1,
        ts: 1_700_000_000_000,  // deterministic so we can predict the archive name
    }, core)

    // Archival: move requested_revisions.md → revisions/requested_revisions.<iso>.md
    const moves = effectsOfType(action, "move_file")
    assertEquals(moves.length, 1)
    assert(moves[0].from.endsWith("/requested_revisions.md"), `unexpected move.from: ${moves[0].from}`)
    assert(
        /\/revisions\/requested_revisions\.2023-.*Z\.md$/.test(moves[0].to),
        `move.to should be under revisions/ and carry an iso ts: ${moves[0].to}`,
    )
    // Colons in the timestamp portion would be filesystem-hostile — confirm they're stripped.
    const tail = moves[0].to.split("/").pop()
    assert(!tail.includes(":"), `archive filename must not contain colons: ${tail}`)

    // Old report.md is deleted so the worker is forced to write a fresh one.
    const deletes = effectsOfType(action, "delete_file")
    assertEquals(deletes.length, 1)
    assert(deletes[0].path.endsWith("/report.md"))

    // The nudge to the worker points at the archive path (the one they
    // should actually read), not the vanished root-level file. Sent via
    // deliver_channel_event (MCP channel), not send_text_to_claude.
    const delivers = effectsOfType(action, "deliver_channel_event")
    assertEquals(delivers.length, 1)
    assert(
        delivers[0].content.includes("/revisions/requested_revisions.") && delivers[0].content.includes(".md"),
        `worker nudge should point at the archive path: ${delivers[0].content}`,
    )

    // Cold-storage entry records where the revision was archived.
    const cold = effectsOfType(action, "cold_append")
    assertEquals(cold[0].entry.event, "revisions_requested")
    assert(cold[0].entry.archivedTo.includes("/revisions/requested_revisions."))
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

Deno.test("critic: legacy clarification_needed verdict is routed as revisions (no user asking)", () => {
    // Tasks run without a user present after the definition is locked,
    // so the critic is no longer allowed to ask questions. The verdict
    // constant still exists as a legacy event shape; it's routed to
    // handleRevisions so the worker keeps going alone.
    const core = coreWithTask(baseTask({ state: "in_progress", definition: "x" }))
    const action = critic({
        taskId: "t1",
        chatId: "42",
        verdict: "clarification_needed",
    }, core)
    // Routed to handleRevisions → state goes back to in_progress,
    // NOT awaiting_clarification. A move_file effect is emitted for
    // the (missing) requested_revisions.md — the handler doesn't check
    // presence, it just emits the archive intent.
    assertEquals(
        get(action, "stateChanges.specialData.longTaskByChatId.42.t1.state"),
        "in_progress",
    )
    assertEquals(effectsOfType(action, "move_file").length, 1)
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
