// tests/interval-hooks-test.js
//
// Unit tests for the interval-hooks feature: create handler, fire
// decision logic, run-complete delivery/tracking, deactivate, and the
// timer count-limit branch.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, writeAccess, makeCore, fakeConn, effectsOfType } from "./_helpers.js"

setupTempPaths("cbg-interval-hooks-test-")
writeAccess(["42"])

const createHook = (await import("../lib/event-handlers/create-interval-hook.js")).default
const fireHook = (await import("../lib/event-handlers/interval-hook-fire.js")).default
const runComplete = (await import("../lib/event-handlers/interval-hook-run-complete.js")).default
const deactivate = (await import("../lib/event-handlers/deactivate-interval-hook.js")).default
const { intervalHookTimerSet } = await import("../lib/effects/interval-hook-timer.js")

const VALID_RULE = { freq: "MINUTELY", interval: 5, tzid: "America/Los_Angeles" }
const VALID_CODE = "export default function () { return null }"

function baseHook(overrides = {}) {
    return {
        id: "ih_abc",
        title: "watcher",
        topic: "cbg",
        createdAt: "2026-07-10T00:00:00Z",
        active: true,
        rule: VALID_RULE,
        timeoutMs: null,
        tracking: {
            totalRuns: 0,
            lastRunAt: null,
            lastRunStatus: null,
            lastResult: null,
            nextFireAt: null,
            skipNext: false,
            runHistory: [],
        },
        currentRun: null,
        ...overrides,
    }
}

function coreWithHook(hook, chatId = "42", extra = {}) {
    return makeCore({
        specialData: { intervalHookByChatId: { [chatId]: { [hook.id]: hook } } },
        ...extra,
    })
}

// ── create ────────────────────────────────────────────────────────────

Deno.test("create: missing topic rejects", () => {
    const action = createHook({ topic: "", code: VALID_CODE, rule: VALID_RULE, _conn: fakeConn(), requestId: "r1" }, makeCore())
    assertEquals(effectsOfType(action, "ipc_respond")[0].message.result.isError, true)
})

Deno.test("create: code without default export rejects", () => {
    const action = createHook({ topic: "cbg", code: "const x = 1", rule: VALID_RULE, _conn: fakeConn(), requestId: "r1" }, makeCore())
    assertEquals(effectsOfType(action, "ipc_respond")[0].message.result.isError, true)
})

Deno.test("create: invalid rule rejects", () => {
    const action = createHook({ topic: "cbg", code: VALID_CODE, rule: { freq: "FORTNIGHTLY" }, _conn: fakeConn(), requestId: "r1" }, makeCore())
    assertEquals(effectsOfType(action, "ipc_respond")[0].message.result.isError, true)
})

Deno.test("create: valid → state + write_file + timer_set + ok ipc", () => {
    const core = makeCore()
    const action = createHook({ topic: "cbg", title: "watcher", code: VALID_CODE, rule: VALID_RULE, _conn: fakeConn(), requestId: "r1", sessionId: "worker" }, core)
    const byChat = action.stateChanges.specialData.intervalHookByChatId["42"]
    const hook = Object.values(byChat)[0]
    assertEquals(hook.active, true)
    assertEquals(hook.topic, "cbg")
    assert(hook.id.startsWith("ih_"))
    assert(effectsOfType(action, "write_file").length >= 2) // hook.js + config.json
    assertEquals(effectsOfType(action, "interval_hook_timer_set").length, 1)
    assertEquals(effectsOfType(action, "ipc_respond")[0].message.result.isError, undefined)
})

// ── fire ──────────────────────────────────────────────────────────────

Deno.test("fire: deactivated hook → null (no rearm)", () => {
    const core = coreWithHook(baseHook({ active: false }))
    assertEquals(fireHook({ chatId: "42", hookId: "ih_abc", fireIso: "2026-07-10T00:05:00Z" }, core), null)
})

Deno.test("fire: previous run in flight → skip + rearm", () => {
    const core = coreWithHook(baseHook({ currentRun: { runIso: "x", startedAt: "y" } }))
    const action = fireHook({ chatId: "42", hookId: "ih_abc", fireIso: "z" }, core)
    assertEquals(effectsOfType(action, "interval_hook_timer_set").length, 1)
    assertEquals(effectsOfType(action, "interval_hook_run").length, 0)
})

Deno.test("fire: skipNext → clears flag + rearm, no run", () => {
    const core = coreWithHook(baseHook({ tracking: { ...baseHook().tracking, skipNext: true } }))
    const action = fireHook({ chatId: "42", hookId: "ih_abc", fireIso: "z" }, core)
    assertEquals(action.stateChanges.specialData.intervalHookByChatId["42"].ih_abc.tracking.skipNext, false)
    assertEquals(effectsOfType(action, "interval_hook_timer_set").length, 1)
    assertEquals(effectsOfType(action, "interval_hook_run").length, 0)
})

Deno.test("fire: normal → sets currentRun + interval_hook_run", () => {
    const core = coreWithHook(baseHook())
    const action = fireHook({ chatId: "42", hookId: "ih_abc", fireIso: "2026-07-10T00:05:00Z" }, core)
    assertEquals(action.stateChanges.specialData.intervalHookByChatId["42"].ih_abc.currentRun.runIso, "2026-07-10T00:05:00Z")
    assertEquals(effectsOfType(action, "interval_hook_run").length, 1)
})

// ── run-complete ────────────────────────────────────────────────────────

function coreWithLiveTopic(hook) {
    return coreWithHook(hook, "42", {
        chatState: {
            commandCenter: {
                topicNames: { "5": "cbg" },
                threadMap: { "5": "Sess" },
                topicMap: { "Sess": "5" },
            },
        },
        chatSessions: { Sess: { id: "Sess", _conn: fakeConn() } },
    })
}

Deno.test("run-complete: message → delivers to live topic session + increments runs", () => {
    const core = coreWithLiveTopic(baseHook())
    const action = runComplete({ chatId: "42", hookId: "ih_abc", runIso: "r", status: "message", result: "hello" }, core)
    const deliver = effectsOfType(action, "deliver_channel_event")
    assertEquals(deliver.length, 1)
    assertEquals(deliver[0].sessionId, "Sess")
    assert(deliver[0].content.includes("hello"))
    const patch = action.stateChanges.specialData.intervalHookByChatId["42"].ih_abc
    assertEquals(patch.tracking.totalRuns, 1)
    assertEquals(patch.currentRun, undefined)
    assertEquals(effectsOfType(action, "interval_hook_timer_set").length, 1)
})

Deno.test("run-complete: noop → no delivery, still increments + rearms", () => {
    const core = coreWithLiveTopic(baseHook())
    const action = runComplete({ chatId: "42", hookId: "ih_abc", runIso: "r", status: "noop" }, core)
    assertEquals(effectsOfType(action, "deliver_channel_event").length, 0)
    assertEquals(action.stateChanges.specialData.intervalHookByChatId["42"].ih_abc.tracking.totalRuns, 1)
    assertEquals(effectsOfType(action, "interval_hook_timer_set").length, 1)
})

Deno.test("run-complete: error → delivers error to topic agent", () => {
    const core = coreWithLiveTopic(baseHook())
    const action = runComplete({ chatId: "42", hookId: "ih_abc", runIso: "r", status: "error", error: "boom" }, core)
    const deliver = effectsOfType(action, "deliver_channel_event")
    assertEquals(deliver.length, 1)
    assert(deliver[0].content.includes("boom"))
})

Deno.test("run-complete: no rearm when deactivated", () => {
    const core = coreWithLiveTopic(baseHook({ active: false }))
    const action = runComplete({ chatId: "42", hookId: "ih_abc", runIso: "r", status: "noop" }, core)
    assertEquals(effectsOfType(action, "interval_hook_timer_set").length, 0)
})

Deno.test("run-complete: dead topic → resurrection (spawn + queued message)", () => {
    // topic exists in maps but bound session has no _conn
    const core = coreWithHook(baseHook(), "42", {
        chatState: {
            commandCenter: {
                topicNames: { "5": "cbg" },
                threadMap: { "5": "DeadSess" },
                topicMap: { "DeadSess": "5" },
            },
        },
        chatSessions: { DeadSess: { id: "DeadSess" } },
    })
    const action = runComplete({ chatId: "42", hookId: "ih_abc", runIso: "r", status: "message", result: "hi" }, core)
    assertEquals(effectsOfType(action, "spawn_dtach_session").length, 1)
    const mq = action.stateChanges.chatState.messageQueue
    assert(mq.some(m => m.content.includes("hi") && m.targetSessionId))
})

// ── deactivate ──────────────────────────────────────────────────────────

Deno.test("deactivate: unknown hook → error ipc", () => {
    const core = coreWithHook(baseHook())
    const action = deactivate({ hookId: "ih_ghost", _conn: fakeConn(), requestId: "r1" }, core)
    assertEquals(effectsOfType(action, "ipc_respond")[0].message.result.isError, true)
})

Deno.test("deactivate: active → sets inactive + timer_clear", () => {
    const core = coreWithHook(baseHook())
    const action = deactivate({ hookId: "ih_abc", _conn: fakeConn(), requestId: "r1" }, core)
    assertEquals(action.stateChanges.specialData.intervalHookByChatId["42"].ih_abc.active, false)
    assertEquals(effectsOfType(action, "interval_hook_timer_clear").length, 1)
})

// ── timer count-limit branch (no real timer set) ────────────────────────

Deno.test("timer_set: count reached → deactivates, sets no timer", async () => {
    const hook = baseHook({ rule: { ...VALID_RULE, count: 2 }, tracking: { ...baseHook().tracking, totalRuns: 2 } })
    const core = coreWithHook(hook)
    const result = await intervalHookTimerSet({ chatId: "42", hookId: "ih_abc", rule: hook.rule }, core)
    assertEquals(result.stateChanges.specialData.intervalHookByChatId["42"].ih_abc.active, false)
})
