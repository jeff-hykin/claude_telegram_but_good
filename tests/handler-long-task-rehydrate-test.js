// tests/handler-long-task-rehydrate-test.js
//
// Regression tests for long-task-rehydrate: after a daemon restart the
// in-memory task_checkin timer is gone, so startup must re-arm it for
// every in_progress long task. Guards the fix for the incident where a
// restart silently killed the nudge watchdog and a task stalled ~5h.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { effectsOfType } from "./_helpers.js"

const rehydrate = (await import("../lib/event-handlers/long-task-rehydrate.js")).default

Deno.test("long-task-rehydrate: re-arms task_checkin timer", () => {
    const action = rehydrate({ taskId: "t1", workerSessionId: "worker", chatId: "42" }, {})
    const timers = effectsOfType(action, "set_timer")
    assertEquals(timers.length, 1)
    assertEquals(timers[0].event.type, "task_checkin")
    assertEquals(timers[0].event.taskId, "t1")
    assertEquals(timers[0].event.sessionId, "worker")
    assertEquals(timers[0].delayMs, 30 * 60 * 1000)
})

Deno.test("long-task-rehydrate: missing taskId returns null (no timer)", () => {
    const action = rehydrate({ workerSessionId: "worker" }, {})
    assertEquals(action, null)
})

Deno.test("long-task-rehydrate: missing workerSessionId returns null (no timer)", () => {
    const action = rehydrate({ taskId: "t1" }, {})
    assertEquals(action, null)
})

// The fired check-in must target the worker so task_checkin's ownership
// guard (session.longTaskId === taskId) passes.
Deno.test("long-task-rehydrate: timer event addresses the worker session", () => {
    const action = rehydrate({ taskId: "abc", workerSessionId: "MutualTurkey" }, {})
    const timer = effectsOfType(action, "set_timer")[0]
    assert(timer)
    assertEquals(timer.event.sessionId, "MutualTurkey")
    assertEquals(timer.event.taskId, "abc")
})
