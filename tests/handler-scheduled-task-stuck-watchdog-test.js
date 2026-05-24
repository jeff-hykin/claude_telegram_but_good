// tests/handler-scheduled-task-stuck-watchdog-test.js
//
// Unit tests for the scheduled-task stuck-run watchdog handler.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, makeCore, effectsOfType } from "./_helpers.js"

setupTempPaths("cbg-stuck-watchdog-test-")

const handle = (await import("../lib/event-handlers/scheduled-task-stuck-watchdog.js")).default

function runningTask(id, startedAt, overrides = {}) {
    return {
        id,
        title: `task ${id}`,
        state: "running",
        rule: { freq: "DAILY", byhour: [12], byminute: [0], tzid: "UTC" },
        currentRun: { runIso: "2026-05-18T21:52:04.000Z", startedAt, attempt: 1 },
        ...overrides,
    }
}

function coreWithTasks(tasksByChat) {
    return makeCore({
        specialData: { scheduledTaskByChatId: tasksByChat },
    })
}

Deno.test("stuck-watchdog: always re-schedules itself", () => {
    const core = coreWithTasks({})
    const action = handle({ type: "scheduled_task_stuck_watchdog" }, core)
    const timers = effectsOfType(action, "set_timer")
    assertEquals(timers.length, 1)
    assertEquals(timers[0].event.type, "scheduled_task_stuck_watchdog")
    assert(timers[0].delayMs > 0)
})

Deno.test("stuck-watchdog: no tasks → no reaping", () => {
    const core = coreWithTasks({})
    const action = handle({ type: "scheduled_task_stuck_watchdog" }, core)
    assertEquals(action.followUpEvents ?? [], [])
})

Deno.test("stuck-watchdog: fresh `running` task is not reaped", () => {
    const fresh = new Date(Date.now() - 10 * 60_000).toISOString()  // 10 min ago
    const core = coreWithTasks({ "42": { s1: runningTask("s1", fresh) } })
    const action = handle({ type: "scheduled_task_stuck_watchdog" }, core)
    assertEquals(action.followUpEvents ?? [], [])
})

Deno.test("stuck-watchdog: task `running` past default threshold is reaped", () => {
    const stale = new Date(Date.now() - 7 * 60 * 60_000).toISOString()  // 7 hours ago
    const core = coreWithTasks({ "42": { s1: runningTask("s1", stale) } })
    const action = handle({ type: "scheduled_task_stuck_watchdog" }, core)
    assertEquals(action.followUpEvents.length, 1)
    const ev = action.followUpEvents[0]
    assertEquals(ev.type, "scheduled_task_run_complete")
    assertEquals(ev.scheduleTaskId, "s1")
    assertEquals(ev.chatId, "42")
    assertEquals(ev.status, "errored")
    assert(ev.summary.includes("Watchdog reaped"))

    // Should also emit a kill effect so the orphan dtach gets ^C'd.
    const kills = effectsOfType(action, "scheduled_task_worker_kill")
    assertEquals(kills.length, 1)
    assertEquals(kills[0].scheduleTaskId, "s1")
    assertEquals(kills[0].runIso, "2026-05-18T21:52:04.000Z")
})

Deno.test("stuck-watchdog: tighter per-task threshold reaps earlier", () => {
    const fortyMinAgo = new Date(Date.now() - 40 * 60_000).toISOString()
    const task = runningTask("s1", fortyMinAgo, { stuckThresholdMs: 30 * 60_000 })
    const core = coreWithTasks({ "42": { s1: task } })
    const action = handle({ type: "scheduled_task_stuck_watchdog" }, core)
    assertEquals(action.followUpEvents.length, 1)
})

Deno.test("stuck-watchdog: tasks in non-running state are ignored", () => {
    const stale = new Date(Date.now() - 24 * 60 * 60_000).toISOString()
    const tasks = {
        "42": {
            scheduled: { ...runningTask("scheduled", stale), state: "scheduled" },
            cancelled: { ...runningTask("cancelled", stale), state: "cancelled" },
            completed: { ...runningTask("completed", stale), state: "completed" },
            errored:   { ...runningTask("errored",   stale), state: "errored" },
            defining:  { ...runningTask("defining",  stale), state: "defining" },
        },
    }
    const core = coreWithTasks(tasks)
    const action = handle({ type: "scheduled_task_stuck_watchdog" }, core)
    assertEquals(action.followUpEvents ?? [], [])
})

Deno.test("stuck-watchdog: task without currentRun.startedAt is skipped", () => {
    const task = runningTask("s1", null)
    task.currentRun = { runIso: "x" }  // no startedAt
    const core = coreWithTasks({ "42": { s1: task } })
    const action = handle({ type: "scheduled_task_stuck_watchdog" }, core)
    assertEquals(action.followUpEvents ?? [], [])
})

Deno.test("stuck-watchdog: multiple stuck tasks across chats are all reaped", () => {
    const stale = new Date(Date.now() - 8 * 60 * 60_000).toISOString()
    const core = coreWithTasks({
        "42": { a: runningTask("a", stale), b: runningTask("b", stale) },
        "99": { c: runningTask("c", stale) },
    })
    const action = handle({ type: "scheduled_task_stuck_watchdog" }, core)
    assertEquals(action.followUpEvents.length, 3)
    const ids = action.followUpEvents.map(e => e.scheduleTaskId).sort()
    assertEquals(ids, ["a", "b", "c"])
})
