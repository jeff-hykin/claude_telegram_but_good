// tests/handler-interval-hook-stuck-watchdog-test.js
//
// Unit tests for the interval-hook watchdog's lost-timer rearm.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, makeCore, effectsOfType } from "./_helpers.js"

setupTempPaths("cbg-ihook-watchdog-test-")

const handle = (await import("../lib/event-handlers/interval-hook-stuck-watchdog.js")).default

function hook(id, nextFireAt, overrides = {}) {
    return {
        id,
        active: true,
        rule: { freq: "MINUTELY", interval: 5, tzid: "UTC" },
        tracking: { nextFireAt },
        ...overrides,
    }
}

function coreWithHooks(hooksByChat) {
    return makeCore({ specialData: { intervalHookByChatId: hooksByChat } })
}

Deno.test("ihook-watchdog: active hook whose fire is long overdue gets its timer rearmed", () => {
    const overdue = new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString()
    const core = coreWithHooks({ "42": { ih_a: hook("ih_a", overdue) } })
    const action = handle({ type: "interval_hook_stuck_watchdog" }, core)
    const rearms = effectsOfType(action, "interval_hook_timer_set")
    assertEquals(rearms.length, 1)
    assertEquals(rearms[0].hookId, "ih_a")
    assertEquals(rearms[0].resumeAt, overdue)
})

Deno.test("ihook-watchdog: upcoming, just-due, inactive and running hooks are left alone", () => {
    const overdue = new Date(Date.now() - 60 * 60_000).toISOString()
    const core = coreWithHooks({
        "42": {
            upcoming: hook("upcoming", new Date(Date.now() + 60_000).toISOString()),
            justDue: hook("justDue", new Date(Date.now() - 60_000).toISOString()),
            inactive: hook("inactive", overdue, { active: false }),
            running: hook("running", overdue, { currentRun: { runIso: overdue, startedAt: new Date().toISOString() } }),
        },
    })
    const action = handle({ type: "interval_hook_stuck_watchdog" }, core)
    assertEquals(effectsOfType(action, "interval_hook_timer_set"), [])
})
