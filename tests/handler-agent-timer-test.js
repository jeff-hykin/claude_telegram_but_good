// tests/handler-agent-timer-test.js
//
// set_reminder / set_repeat arm bare in-memory setTimeouts, so a daemon
// restart used to eat every pending one silently. These tests cover the
// durable half: the record each timer keeps in specialData.agentTimers, the
// rehydration that re-arms it on boot, and the reconnect grace that stops a
// fire landing on a session whose socket hasn't come back yet from being
// thrown away.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, makeCore, fakeConn, effectsOfType, get } from "./_helpers.js"

setupTempPaths("cbg-agent-timer-test-")

const channel = (await import("../lib/event-handlers/claude-channel.js")).default
const fire = (await import("../lib/event-handlers/agent-timer-fire.js")).default
const rehydrate = (await import("../lib/event-handlers/agent-timer-rehydrate.js")).default
const {
    RESUME_GRACE_MS,
    RECONNECT_RETRY_MS,
    MAX_RECONNECT_RETRIES,
    STALE_AFTER_MS,
    makeTimerRecord,
    resumeDelayMs,
    isStale,
} = await import("../lib/pure/agent-timers.js")

const SESSION = "sess-1"

function toolEvent(toolName, args = {}) {
    return {
        type: "claude_channel_tool_request",
        ts: 1_000,
        sessionId: SESSION,
        requestId: "req-1",
        toolName,
        args,
        _conn: fakeConn("shim"),
    }
}

/** A core with one live (socket-connected) session. */
function liveCore(specialData = {}) {
    return makeCore({
        chatSessions: { [SESSION]: { id: SESSION, _conn: fakeConn("shim") } },
        specialData,
    })
}

function timersOf(action) {
    return get(action, "stateChanges.specialData.agentTimers") ?? {}
}

// ── arming writes a durable record ────────────────────────────────────

Deno.test("set_reminder: records the pending timer in specialData", () => {
    const core = liveCore()
    const action = channel(toolEvent("set_reminder", { message: "check the build", delay_seconds: 600 }), core)

    const timers = timersOf(action)
    const ids = Object.keys(timers)
    assertEquals(ids.length, 1)
    const record = timers[ids[0]]
    assertEquals(record.sessionId, SESSION)
    assertEquals(record.message, "check the build")
    assertEquals(record.kind, "reminder")
    assert(record.fireAt > Date.now() + 500_000, "fireAt is ~10 min out")

    // ...and still arms the in-memory timer.
    const armed = effectsOfType(action, "set_timer")
    assertEquals(armed.length, 1)
    assertEquals(armed[0].delayMs, 600_000)
    assertEquals(armed[0].event.timerId, ids[0])
})

Deno.test("set_reminder: ids are unique within the same millisecond", () => {
    const core = liveCore()
    const a = channel(toolEvent("set_reminder", { message: "one", delay_seconds: 60 }), core)
    const b = channel(toolEvent("set_reminder", { message: "two", delay_seconds: 60 }), core)
    assert(Object.keys(timersOf(a))[0] !== Object.keys(timersOf(b))[0])
})

Deno.test("set_repeat: records interval, max_count and the next fire", () => {
    const core = liveCore()
    const action = channel(toolEvent("set_repeat", { message: "poll", interval_seconds: 300, max_count: 4 }), core)
    const record = Object.values(timersOf(action))[0]
    assertEquals(record.kind, "repeat")
    assertEquals(record.intervalMs, 300_000)
    assertEquals(record.maxCount, 4)
    assertEquals(record.fireCount, 0)
})

Deno.test("cancel_reminder: drops the record so a restart can't re-arm it", () => {
    const core = liveCore({ agentTimers: { rem_x: makeTimerRecord({ id: "rem_x", sessionId: SESSION, message: "m", kind: "reminder", fireAt: Date.now() + 1000 }) } })
    const action = channel(toolEvent("cancel_reminder", { id: "rem_x" }), core)
    assertEquals(Object.keys(timersOf(action)), ["rem_x"])
    assertEquals(timersOf(action).rem_x, undefined)
    // The in-memory setTimeout can't be unscheduled, so the fire-time check
    // stays too.
    assertEquals(get(action, `stateChanges.chatSessions.${SESSION}.cancelledTimers.rem_x`), true)
})

Deno.test("snooze_reminder: recovers the message from the durable record", () => {
    // `_lastTimerMessages` is underscore-prefixed, so it is stripped by the
    // persistence layer — after a restart it is empty and the record is the
    // only place the text survives.
    const core = liveCore({
        agentTimers: { rem_x: makeTimerRecord({ id: "rem_x", sessionId: SESSION, message: "the real text", kind: "reminder", fireAt: Date.now() }) },
    })
    const action = channel(toolEvent("snooze_reminder", { id: "rem_x", delay_seconds: 120 }), core)
    assertEquals(effectsOfType(action, "set_timer")[0].event.message, "the real text")
    assertEquals(timersOf(action).rem_x.message, "the real text")
})

Deno.test("snooze_reminder: snoozing a repeat leaves the repeat's record alone", () => {
    const repeat = makeTimerRecord({ id: "rpt_x", sessionId: SESSION, message: "poll", kind: "repeat", fireAt: Date.now() + 300_000, intervalMs: 300_000 })
    const core = liveCore({ agentTimers: { rpt_x: repeat } })
    const action = channel(toolEvent("snooze_reminder", { id: "rpt_x", delay_seconds: 60 }), core)
    assertEquals(get(action, "stateChanges.specialData"), undefined)
    assertEquals(effectsOfType(action, "set_timer").length, 1)
})

// ── firing maintains the record ───────────────────────────────────────

function fireEvent(overrides = {}) {
    return { type: "agent_timer_fire", sessionId: SESSION, timerId: "rem_x", message: "ping", kind: "reminder", ...overrides }
}

Deno.test("fire: a one-shot delivers and retires its record", () => {
    const core = liveCore({ agentTimers: { rem_x: makeTimerRecord({ id: "rem_x", sessionId: SESSION, message: "ping", kind: "reminder", fireAt: Date.now() }) } })
    const action = fire(fireEvent(), core)
    assertEquals(effectsOfType(action, "deliver_channel_event").length, 1)
    assertEquals(timersOf(action).rem_x, undefined)
    assert("rem_x" in timersOf(action), "the key is present as an explicit delete sentinel")
})

Deno.test("fire: a repeat advances its record and re-arms", () => {
    const record = makeTimerRecord({ id: "rpt_x", sessionId: SESSION, message: "poll", kind: "repeat", fireAt: Date.now(), intervalMs: 300_000, maxCount: 4 })
    const core = liveCore({ agentTimers: { rpt_x: record } })
    const now = Date.now()
    const action = fire(fireEvent({ timerId: "rpt_x", kind: "repeat", intervalMs: 300_000, maxCount: 4, fireCount: 1, ts: now }), core)
    assertEquals(effectsOfType(action, "set_timer").length, 1)
    assertEquals(timersOf(action).rpt_x.fireCount, 2)
    assertEquals(timersOf(action).rpt_x.fireAt, now + 300_000)
    assertEquals(timersOf(action).rpt_x.misses, 0)
})

Deno.test("fire: a repeat that hits max_count retires its record", () => {
    const core = liveCore({ agentTimers: { rpt_x: makeTimerRecord({ id: "rpt_x", sessionId: SESSION, message: "poll", kind: "repeat", fireAt: Date.now(), intervalMs: 1000, maxCount: 2 }) } })
    const action = fire(fireEvent({ timerId: "rpt_x", kind: "repeat", intervalMs: 1000, maxCount: 2, fireCount: 1 }), core)
    assertEquals(effectsOfType(action, "set_timer").length, 0)
    assertEquals(timersOf(action).rpt_x, undefined)
    assert("rpt_x" in timersOf(action))
})

Deno.test("fire: a cancelled timer delivers nothing and drops its record", () => {
    const core = makeCore({
        chatSessions: { [SESSION]: { id: SESSION, _conn: fakeConn("shim"), cancelledTimers: { rem_x: true } } },
        specialData: { agentTimers: { rem_x: makeTimerRecord({ id: "rem_x", sessionId: SESSION, message: "ping", kind: "reminder", fireAt: Date.now() }) } },
    })
    const action = fire(fireEvent(), core)
    assertEquals(effectsOfType(action, "deliver_channel_event").length, 0)
    assertEquals(timersOf(action).rem_x, undefined)
})

// ── the reconnect window after a restart ──────────────────────────────

Deno.test("fire: a session whose socket hasn't come back is retried, not dropped", () => {
    // This is the normal state for the first seconds after a daemon restart:
    // chatSessions is loaded from disk, but _conn is stripped by persistence
    // and only comes back when the shim reconnects.
    const core = makeCore({
        chatSessions: { [SESSION]: { id: SESSION } },
        specialData: { agentTimers: { rem_x: makeTimerRecord({ id: "rem_x", sessionId: SESSION, message: "ping", kind: "reminder", fireAt: Date.now() }) } },
    })
    const action = fire(fireEvent(), core)
    assertEquals(effectsOfType(action, "deliver_channel_event").length, 0)
    const retry = effectsOfType(action, "set_timer")
    assertEquals(retry.length, 1)
    assertEquals(retry[0].delayMs, RECONNECT_RETRY_MS)
    assertEquals(retry[0].event.misses, 1)
    assertEquals(timersOf(action).rem_x.misses, 1)
})

Deno.test("fire: the retry budget is finite and the last attempt still delivers", () => {
    const core = makeCore({
        chatSessions: { [SESSION]: { id: SESSION } },
        specialData: { agentTimers: { rem_x: makeTimerRecord({ id: "rem_x", sessionId: SESSION, message: "ping", kind: "reminder", fireAt: Date.now() }) } },
    })
    const action = fire(fireEvent({ misses: MAX_RECONNECT_RETRIES }), core)
    assertEquals(effectsOfType(action, "set_timer").length, 0)
    // deliver_channel_event writes the session inbox even with no socket, so
    // the reminder is readable later rather than lost.
    assertEquals(effectsOfType(action, "deliver_channel_event").length, 1)
    assertEquals(timersOf(action).rem_x, undefined)
})

Deno.test("fire: a timer with no record still stops retrying eventually", () => {
    const core = makeCore({ chatSessions: { [SESSION]: { id: SESSION } } })
    const retried = fire(fireEvent(), core)
    assertEquals(effectsOfType(retried, "set_timer")[0].event.misses, 1)
    const exhausted = fire(fireEvent({ misses: MAX_RECONNECT_RETRIES }), core)
    assertEquals(effectsOfType(exhausted, "set_timer").length, 0)
})

// ── rehydration ───────────────────────────────────────────────────────

Deno.test("rehydrate: a fire time still in the future is honored exactly", () => {
    const fireAt = Date.now() + 45 * 60 * 1000
    const core = liveCore({ agentTimers: { rem_x: makeTimerRecord({ id: "rem_x", sessionId: SESSION, message: "ping", kind: "reminder", fireAt }) } })
    const action = rehydrate({ type: "agent_timer_rehydrate", timerId: "rem_x" }, core)
    const armed = effectsOfType(action, "set_timer")
    assertEquals(armed.length, 1)
    assert(Math.abs(armed[0].delayMs - (fireAt - Date.now())) < 2000)
    assertEquals(armed[0].event.type, "agent_timer_fire")
    assertEquals(armed[0].event.message, "ping")
})

Deno.test("rehydrate: a fire time slept through is replayed, not skipped", () => {
    const core = liveCore({ agentTimers: { rem_x: makeTimerRecord({ id: "rem_x", sessionId: SESSION, message: "ping", kind: "reminder", fireAt: Date.now() - 60 * 60 * 1000 }) } })
    const action = rehydrate({ type: "agent_timer_rehydrate", timerId: "rem_x" }, core)
    assertEquals(effectsOfType(action, "set_timer")[0].delayMs, RESUME_GRACE_MS)
})

Deno.test("rehydrate: a repeat comes back with its cadence intact", () => {
    const record = makeTimerRecord({ id: "rpt_x", sessionId: SESSION, message: "poll", kind: "repeat", fireAt: Date.now() - 1000, intervalMs: 300_000, maxCount: 4, fireCount: 2 })
    const core = liveCore({ agentTimers: { rpt_x: record } })
    const armed = effectsOfType(rehydrate({ type: "agent_timer_rehydrate", timerId: "rpt_x" }, core), "set_timer")[0]
    assertEquals(armed.event.intervalMs, 300_000)
    assertEquals(armed.event.maxCount, 4)
    assertEquals(armed.event.fireCount, 2)
})

Deno.test("rehydrate: a long-dead one-shot is dropped instead of fired", () => {
    const core = liveCore({ agentTimers: { rem_x: makeTimerRecord({ id: "rem_x", sessionId: SESSION, message: "ping", kind: "reminder", fireAt: Date.now() - STALE_AFTER_MS - 1000 }) } })
    const action = rehydrate({ type: "agent_timer_rehydrate", timerId: "rem_x" }, core)
    assertEquals(effectsOfType(action, "set_timer").length, 0)
    assertEquals(timersOf(action).rem_x, undefined)
})

Deno.test("rehydrate: a missing record is a no-op", () => {
    assertEquals(rehydrate({ type: "agent_timer_rehydrate", timerId: "gone" }, liveCore()), null)
})

// ── the pure helpers ──────────────────────────────────────────────────

Deno.test("resumeDelayMs: never negative, never re-derived from boot time", () => {
    const now = 1_000_000
    assertEquals(resumeDelayMs({ fireAt: now + 5000 }, now), 5000)
    assertEquals(resumeDelayMs({ fireAt: now - 5000 }, now), RESUME_GRACE_MS)
    assertEquals(resumeDelayMs({}, now), RESUME_GRACE_MS)
})

Deno.test("isStale: junk and long-dead one-shots only", () => {
    const now = 1_000_000_000
    assert(isStale(null, now))
    assert(isStale({ sessionId: SESSION, message: "m", kind: "reminder" }, now))
    assert(isStale({ sessionId: SESSION, kind: "reminder", fireAt: now }, now))
    assert(isStale({ sessionId: SESSION, message: "m", kind: "reminder", fireAt: now - STALE_AFTER_MS - 1 }, now))
    assert(!isStale({ sessionId: SESSION, message: "m", kind: "reminder", fireAt: now - 1000 }, now))
    // A repeat is overdue because the daemon was down, not because it's junk.
    assert(!isStale({ sessionId: SESSION, message: "m", kind: "repeat", fireAt: now - STALE_AFTER_MS * 10 }, now))
})
