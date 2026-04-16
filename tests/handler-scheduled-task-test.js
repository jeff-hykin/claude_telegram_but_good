// tests/handler-scheduled-task-test.js
//
// Unit tests for the /schedule feature handlers.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, makeCore, fakeConn, effectsOfType } from "./_helpers.js"

setupTempPaths("cbg-schedule-test-")

const submit = (await import("../lib/event-handlers/scheduled-task-definition-submitted.js")).default

function baseDefining(overrides = {}) {
    return {
        id: "s1",
        title: "daily commits",
        createdAt: "2026-04-13T00:00:00Z",
        originalPrompt: "check my github for commits",
        definitionOfDone: null,
        rule: null,
        state: "defining",
        draftingSessionId: "worker",
        tracking: {
            totalRuns: 0,
            lastRunAt: null,
            lastRunStatus: null,
            nextFireAt: null,
            skipNext: false,
            runHistory: [],
        },
        currentRun: null,
        ...overrides,
    }
}

function coreWithTask(task, chatId = "42") {
    return makeCore({
        specialData: {
            scheduledTaskByChatId: {
                [chatId]: { [task.id]: task },
            },
        },
    })
}

Deno.test("schedule-submit: empty definition rejects with error", () => {
    const core = coreWithTask(baseDefining())
    const action = submit({
        scheduleTaskId: "s1",
        rule: { freq: "DAILY", byhour: [15], byminute: [0], tzid: "America/Los_Angeles" },
        definitionOfDone: "",
        sessionId: "worker",
        requestId: "r1",
        _conn: fakeConn(),
    }, core)
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc[0].message.result.isError, true)
})

Deno.test("schedule-submit: unknown task returns error", () => {
    const core = coreWithTask(baseDefining())
    const action = submit({
        scheduleTaskId: "ghost",
        rule: { freq: "DAILY", byhour: [15], byminute: [0], tzid: "America/Los_Angeles" },
        definitionOfDone: "# done when ...",
        sessionId: "worker",
        requestId: "r1",
        _conn: fakeConn(),
    }, core)
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc[0].message.result.isError, true)
})

Deno.test("schedule-submit: session mismatch rejects", () => {
    const core = coreWithTask(baseDefining({ draftingSessionId: "other" }))
    const action = submit({
        scheduleTaskId: "s1",
        rule: { freq: "DAILY", byhour: [15], byminute: [0], tzid: "America/Los_Angeles" },
        definitionOfDone: "# done",
        sessionId: "worker",
        requestId: "r1",
        _conn: fakeConn(),
    }, core)
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc[0].message.result.isError, true)
})

Deno.test("schedule-submit: wrong state rejects", () => {
    const core = coreWithTask(baseDefining({ state: "scheduled" }))
    const action = submit({
        scheduleTaskId: "s1",
        rule: { freq: "DAILY", byhour: [15], byminute: [0], tzid: "America/Los_Angeles" },
        definitionOfDone: "# done",
        sessionId: "worker",
        requestId: "r1",
        _conn: fakeConn(),
    }, core)
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc[0].message.result.isError, true)
})

Deno.test("schedule-submit: invalid rule rejects", () => {
    const core = coreWithTask(baseDefining())
    const action = submit({
        scheduleTaskId: "s1",
        rule: { freq: "FORTNIGHTLY" },
        definitionOfDone: "# done",
        sessionId: "worker",
        requestId: "r1",
        _conn: fakeConn(),
    }, core)
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc[0].message.result.isError, true)
})

Deno.test("schedule-submit: valid submission locks + emits timer_set, write_file, cold_append, user message", () => {
    const core = coreWithTask(baseDefining())
    const action = submit({
        scheduleTaskId: "s1",
        rule: { freq: "DAILY", byhour: [15], byminute: [0], tzid: "America/Los_Angeles" },
        definitionOfDone: "# done\n- criterion 1",
        title: "daily commits",
        sessionId: "worker",
        requestId: "r1",
        _conn: fakeConn(),
    }, core)
    // Task flipped to scheduled
    const patch = action.stateChanges.specialData.scheduledTaskByChatId["42"].s1
    assertEquals(patch.state, "scheduled")
    assertEquals(patch.definitionOfDone, "# done\n- criterion 1")
    assertEquals(patch.draftingSessionId, undefined)
    assertEquals(effectsOfType(action, "schedule_timer_set").length, 1)
    assert(effectsOfType(action, "write_file").length >= 1)
    assertEquals(effectsOfType(action, "cold_append").length, 1)
    assertEquals(effectsOfType(action, "send_text_to_user").length, 1)
    const ipc = effectsOfType(action, "ipc_respond")[0]
    assertEquals(ipc.message.result.isError, undefined)
})
