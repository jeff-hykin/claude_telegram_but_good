// tests/handler-stall-detector-test.js
//
// Unit tests for the stall detector pair:
//   - screen-snapshot.js (periodic tail hasher + rescheduler)
//   - stall-check.js (generation-aware stall detector)
//
// Both handlers are pure in the event-loop sense — they take
// (event, core) and return an Action. The screen-snapshot handler
// does read the filesystem (the dtach log tails), which we exercise
// with real temp files in paths.STATE_DIR.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, makeCore, effectsOfType, get, paths } from "./_helpers.js"

setupTempPaths("cbg-stall-test-")

const snapshotHandle = (await import("../lib/event-handlers/screen-snapshot.js")).default
const stallMod = await import("../lib/event-handlers/stall-check.js")
const stallHandle = stallMod.default
const isStalled = stallMod.isStalled

// ── isStalled() ──────────────────────────────────────────────────────
//
// Pure predicate, easy to unit test.

Deno.test("isStalled: empty record is not stalled", () => {
    assertEquals(isStalled([], 100_000, 60_000), false)
})

Deno.test("isStalled: single recent entry is not stalled (window not yet old enough)", () => {
    const record = [{ hash: "aa", ts: 100_000 }]
    // Most recent entry is at 100_000, now is 120_000, window is 60_000.
    // The oldest entry is only 20 s old — not enough history.
    assertEquals(isStalled(record, 120_000, 60_000), false)
})

Deno.test("isStalled: all identical hashes with oldest beyond window → stalled", () => {
    const record = [
        { hash: "aa", ts: 0 },
        { hash: "aa", ts: 20_000 },
        { hash: "aa", ts: 40_000 },
        { hash: "aa", ts: 60_000 },
    ]
    // Oldest entry is 80 s old at now=80_000; stall window is 60_000.
    // All hashes match — stalled.
    assertEquals(isStalled(record, 80_000, 60_000), true)
})

Deno.test("isStalled: a different hash in the window → NOT stalled", () => {
    const record = [
        { hash: "aa", ts: 0 },
        { hash: "bb", ts: 20_000 },   // different!
        { hash: "aa", ts: 40_000 },
        { hash: "aa", ts: 60_000 },
    ]
    assertEquals(isStalled(record, 80_000, 60_000), false)
})

Deno.test("isStalled: oldest entry NOT older than window → not stalled", () => {
    const record = [
        { hash: "aa", ts: 30_000 },   // only 30 s old
        { hash: "aa", ts: 40_000 },
        { hash: "aa", ts: 50_000 },
    ]
    assertEquals(isStalled(record, 60_000, 60_000), false)
})

// ── stall-check handler ──────────────────────────────────────────────

function stallEvent(sessionId, forAgentRequest, overrides = {}) {
    return {
        type: "stall_check",
        sessionId,
        forAgentRequest,
        ts: 100_000,
        ...overrides,
    }
}

Deno.test("stall-check: stale timer (agentRequest moved on) → no-op", () => {
    const core = makeCore({
        chatSessions: {
            "sess-1": {
                id: "sess-1",
                agentRequest: 5,           // current
                status: "working",
                screenBufferRecord: [],
            },
        },
    })
    const action = stallHandle(stallEvent("sess-1", 3), core)
    // The timer was scheduled for request 3 but we're on 5 now — exit silently.
    assertEquals(action.effects?.length ?? 0, 0)
    assertEquals(Object.keys(action.stateChanges ?? {}).length, 0)
})

Deno.test("stall-check: session already idle → no-op", () => {
    const core = makeCore({
        chatSessions: {
            "sess-1": {
                id: "sess-1",
                agentRequest: 3,
                status: "idle",
                screenBufferRecord: [],
            },
        },
    })
    const action = stallHandle(stallEvent("sess-1", 3), core)
    assertEquals(action.effects?.length ?? 0, 0)
})

Deno.test("stall-check: session gone → no-op", () => {
    const core = makeCore({ chatSessions: {} })
    const action = stallHandle(stallEvent("sess-ghost", 1), core)
    assertEquals(action.effects?.length ?? 0, 0)
})

Deno.test("stall-check: screen still moving → reschedules itself with SAME forAgentRequest", () => {
    const core = makeCore({
        chatSessions: {
            "sess-1": {
                id: "sess-1",
                agentRequest: 7,
                status: "working",
                screenBufferRecord: [
                    { hash: "aa", ts: 0 },
                    { hash: "bb", ts: 20_000 },   // movement
                    { hash: "cc", ts: 40_000 },
                ],
            },
        },
    })
    const action = stallHandle(stallEvent("sess-1", 7), core)
    const timers = effectsOfType(action, "set_timer")
    assertEquals(timers.length, 1)
    assertEquals(timers[0].event.type, "stall_check")
    assertEquals(timers[0].event.sessionId, "sess-1")
    assertEquals(timers[0].event.forAgentRequest, 7)
    // No synthetic Stop yet.
    assertEquals((action.followUpEvents ?? []).length, 0)
})

Deno.test("stall-check: stalled → marks frozen + enqueues synthetic Stop + does NOT reschedule", () => {
    const core = makeCore({
        chatSessions: {
            "sess-1": {
                id: "sess-1",
                agentRequest: 7,
                status: "working",
                screenBufferRecord: [
                    { hash: "aa", ts: 0 },
                    { hash: "aa", ts: 20_000 },
                    { hash: "aa", ts: 40_000 },
                ],
            },
        },
    })
    // now=100_000, stall window 60_000; oldest is 100s old, all hashes match.
    const action = stallHandle(stallEvent("sess-1", 7, { ts: 100_000 }), core)
    assertEquals(get(action, "stateChanges.chatSessions.sess-1.status"), "frozen")
    assertEquals(effectsOfType(action, "set_timer").length, 0)
    const follow = action.followUpEvents ?? []
    assertEquals(follow.length, 1)
    assertEquals(follow[0].type, "claude_hook_stop")
    assertEquals(follow[0].sessionId, "sess-1")
    assertEquals(follow[0].synthetic, true)
})

// ── screen-snapshot handler ──────────────────────────────────────────

Deno.test("screen-snapshot: reads tail + appends to ring + reschedules", () => {
    // Set up a fake dtach log file for sess-1 under paths.STATE_DIR.
    const sessionId = "sess-1"
    const sockPath = paths.dtachSockFile(sessionId)
    const logPath = sockPath.replace(/\.sock$/, ".log")
    Deno.writeTextFileSync(logPath, "some screen output\n")

    const core = makeCore({
        chatSessions: {
            [sessionId]: {
                id: sessionId,
                dtachSocket: sockPath,
                screenBufferRecord: [],
            },
        },
    })
    const action = snapshotHandle({ type: "screen_snapshot_tick", ts: 50_000 }, core)
    const patch = get(action, `stateChanges.chatSessions.${sessionId}.screenBufferRecord`)
    assert(Array.isArray(patch), "screenBufferRecord should be an array")
    assertEquals(patch.length, 1)
    assertEquals(typeof patch[0].hash, "string")
    assert(patch[0].hash.length >= 1, "hash should be non-empty")
    assertEquals(patch[0].ts, 50_000)
    // Self-reschedules.
    const timers = effectsOfType(action, "set_timer")
    assertEquals(timers.length, 1)
    assertEquals(timers[0].event.type, "screen_snapshot_tick")

    Deno.removeSync(logPath)
})

Deno.test("screen-snapshot: different tail content produces different hash across ticks", () => {
    const sessionId = "sess-hash"
    const sockPath = paths.dtachSockFile(sessionId)
    const logPath = sockPath.replace(/\.sock$/, ".log")

    Deno.writeTextFileSync(logPath, "frame one\n")
    const core1 = makeCore({
        chatSessions: {
            [sessionId]: { id: sessionId, dtachSocket: sockPath, screenBufferRecord: [] },
        },
    })
    const action1 = snapshotHandle({ type: "screen_snapshot_tick", ts: 1_000 }, core1)
    const patch1 = get(action1, `stateChanges.chatSessions.${sessionId}.screenBufferRecord`)
    const hash1 = patch1[0].hash

    Deno.writeTextFileSync(logPath, "frame two — something very different\n")
    const core2 = makeCore({
        chatSessions: {
            [sessionId]: { id: sessionId, dtachSocket: sockPath, screenBufferRecord: patch1 },
        },
    })
    const action2 = snapshotHandle({ type: "screen_snapshot_tick", ts: 2_000 }, core2)
    const patch2 = get(action2, `stateChanges.chatSessions.${sessionId}.screenBufferRecord`)
    const hash2 = patch2[patch2.length - 1].hash

    assert(hash1 !== hash2, `expected hashes to differ; got ${hash1} vs ${hash2}`)
    assertEquals(patch2.length, 2, "ring should grow on successive ticks")

    Deno.removeSync(logPath)
})

Deno.test("screen-snapshot: missing log file is skipped silently (no patch emitted)", () => {
    const sessionId = "sess-nofile"
    const sockPath = paths.dtachSockFile(sessionId)
    // Do NOT create the log file.

    const core = makeCore({
        chatSessions: {
            [sessionId]: { id: sessionId, dtachSocket: sockPath, screenBufferRecord: [] },
        },
    })
    const action = snapshotHandle({ type: "screen_snapshot_tick", ts: 50_000 }, core)
    // No session patch, but still reschedules.
    const patch = get(action, `stateChanges.chatSessions.${sessionId}`)
    assertEquals(patch, undefined)
    assertEquals(effectsOfType(action, "set_timer").length, 1)
})

Deno.test("screen-snapshot: ring buffer caps at (2*stall)/interval ≈ 6 entries by default", () => {
    const sessionId = "sess-ring"
    const sockPath = paths.dtachSockFile(sessionId)
    const logPath = sockPath.replace(/\.sock$/, ".log")
    Deno.writeTextFileSync(logPath, "x")

    // Prefill a record with 10 stale entries.
    const stale = Array.from({ length: 10 }, (_, i) => ({ hash: `h${i}`, ts: i * 1000 }))
    const core = makeCore({
        chatSessions: {
            [sessionId]: { id: sessionId, dtachSocket: sockPath, screenBufferRecord: stale },
        },
    })
    const action = snapshotHandle({ type: "screen_snapshot_tick", ts: 20_000 }, core)
    const patch = get(action, `stateChanges.chatSessions.${sessionId}.screenBufferRecord`)
    // At defaults (60s stall / 20s interval), ring size = ceil(120/20) = 6.
    assertEquals(patch.length, 6)
    // Newest entry is at the end.
    assertEquals(patch[patch.length - 1].ts, 20_000)

    Deno.removeSync(logPath)
})
