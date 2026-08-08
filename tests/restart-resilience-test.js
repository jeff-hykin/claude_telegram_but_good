// tests/restart-resilience-test.js
//
// Three bugs that together let a daemon restart cost real work: a
// connectivity heartbeat that measured the user's idleness rather than
// the bot's health, rehydration that re-derived every schedule from the
// restart moment, and two cold-storage streams that were never allowed
// to be written.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, paths, makeCore, effectsOfType } from "./_helpers.js"

const { tempDir: _tempDir } = setupTempPaths("cbg-restart-resilience-test-")

const healthHandle = (await import("../lib/event-handlers/bot-health-check.js")).default
const schedRehydrate = (await import("../lib/event-handlers/scheduled-task-rehydrate.js")).default
const hookRehydrate = (await import("../lib/event-handlers/interval-hook-rehydrate.js")).default
const { scheduleTimerSet } = await import("../lib/effects/schedule-timer.js")
// Through versionedImport so this is the same registry instance the
// effect writes to — a bare import would be a second, empty singleton.
const { versionedImport } = await import("../lib/version.js")
const { clearScheduleTimer } = await versionedImport("../lib/scheduler/timer-registry.js", import.meta)
const { resolveResumeFire, MISSED_FIRE_DELAY_MS } = await import("../lib/scheduler/index.js")
const coldStorage = await import("../lib/cold-storage.js")

const CHAT = "-100777"
const EVERY_3H = { freq: "HOURLY", interval: 3 }

function botStub({ ping = true, pollingDied = false } = {}) {
    return {
        ping: async () => ping,
        restart: async () => true,
        pollingHealth: {
            started: true,
            startedAt: 0,
            lastMessageAt: Date.now(),
            pollingDied,
            restartCount: 0,
            msSinceLastMessage: 0,
        },
    }
}

// ── connectivity heartbeat ────────────────────────────────────────────

Deno.test("health check: a reachable bot refreshes the heartbeat with no user traffic", async () => {
    const action = await healthHandle({}, makeCore({ bot: botStub() }))
    const writes = effectsOfType(action, "write_file")
    assertEquals(writes.length, 1)
    assertEquals(writes[0].path, paths.LAST_CONNECTIVITY_FILE)
    assert(Number(writes[0].content) > 0)
})

Deno.test("health check: an unreachable bot lets the heartbeat go stale", async () => {
    const action = await healthHandle({}, makeCore({ bot: botStub({ ping: false }) }))
    assertEquals(effectsOfType(action, "write_file").length, 0)
})

Deno.test("health check: no adapter is not a connectivity failure", async () => {
    const action = await healthHandle({}, makeCore({ bot: null }))
    assertEquals(effectsOfType(action, "write_file").length, 1)
})

Deno.test("health check: always re-arms its own tick", async () => {
    const action = await healthHandle({}, makeCore({ bot: botStub({ pollingDied: true }) }))
    assertEquals(effectsOfType(action, "set_timer").length, 1)
})

// ── resuming a schedule across a restart ──────────────────────────────

Deno.test("resolveResumeFire: a future fire time is honored exactly", () => {
    const now = new Date("2026-08-06T12:00:00Z")
    const resumed = resolveResumeFire("2026-08-06T14:00:00Z", EVERY_3H, now)
    assertEquals(resumed.at.toISOString(), "2026-08-06T14:00:00.000Z")
    assertEquals(resumed.missed, false)
})

Deno.test("resolveResumeFire: a fire slept through is replayed, not skipped", () => {
    const now = new Date("2026-08-06T12:00:00Z")
    const resumed = resolveResumeFire("2026-08-06T09:00:00Z", EVERY_3H, now)
    assertEquals(resumed.missed, true)
    assertEquals(resumed.at.getTime(), now.getTime() + MISSED_FIRE_DELAY_MS)
})

Deno.test("resolveResumeFire: never resumes past the rule's own end", () => {
    const now = new Date("2026-08-06T12:00:00Z")
    const rule = { ...EVERY_3H, until: "2026-08-06T10:00:00Z" }
    assertEquals(resolveResumeFire("2026-08-06T09:00:00Z", rule, now), null)
})

Deno.test("resolveResumeFire: nothing persisted means fall back to the rule", () => {
    assertEquals(resolveResumeFire(null, EVERY_3H), null)
    assertEquals(resolveResumeFire("not a date", EVERY_3H), null)
})

Deno.test("rehydrate carries the persisted fire time so restarts don't postpone it", () => {
    const core = makeCore({
        specialData: {
            scheduledTaskByChatId: {
                [CHAT]: { "sch_1": { rule: EVERY_3H, tracking: { nextFireAt: "2026-08-06T14:00:00Z" } } },
            },
        },
    })
    const effect = schedRehydrate({ chatId: CHAT, scheduleTaskId: "sch_1", rule: EVERY_3H }, core).effects[0]
    assertEquals(effect.resumeAt, "2026-08-06T14:00:00Z")
})

Deno.test("interval hooks rehydrate the same way", () => {
    const core = makeCore({
        specialData: {
            intervalHookByChatId: {
                [CHAT]: { "ih_1": { rule: EVERY_3H, tracking: { nextFireAt: "2026-08-06T14:00:00Z" } } },
            },
        },
    })
    const effect = hookRehydrate({ chatId: CHAT, hookId: "ih_1", rule: EVERY_3H }, core).effects[0]
    assertEquals(effect.resumeAt, "2026-08-06T14:00:00Z")
})

Deno.test("a task with nothing persisted still rehydrates off the rule", () => {
    const core = makeCore({ specialData: {} })
    const effect = schedRehydrate({ chatId: CHAT, scheduleTaskId: "sch_1", rule: EVERY_3H }, core).effects[0]
    assertEquals(effect.resumeAt, undefined)
})

Deno.test("repeated restarts cannot walk a schedule into the future", async () => {
    // The exact shape of the reported starvation: six watchdog restarts
    // over five hours pushed a 3h schedule out to a 10h gap.
    const firstFire = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
    const core = makeCore({
        specialData: {
            scheduledTaskByChatId: {
                [CHAT]: { "sch_1": { rule: EVERY_3H, tracking: { nextFireAt: firstFire } } },
            },
        },
    })

    for (let restart = 0; restart < 6; restart++) {
        const effect = schedRehydrate({ chatId: CHAT, scheduleTaskId: "sch_1", rule: EVERY_3H }, core).effects[0]
        const patch = await scheduleTimerSet(effect, core)
        const nextFire = patch.stateChanges.specialData.scheduledTaskByChatId[CHAT]["sch_1"].tracking.nextFireAt
        assertEquals(nextFire, firstFire, `restart ${restart} moved the fire time`)
        core.specialData.scheduledTaskByChatId[CHAT]["sch_1"].tracking.nextFireAt = nextFire
    }
    clearScheduleTimer("sch_1")
})

// ── cold-storage streams ──────────────────────────────────────────────

Deno.test("the scheduler streams are writable", () => {
    for (const stream of ["scheduled-tasks", "interval-hooks"]) {
        coldStorage.appendColdEntry(stream, { kind: "fire", id: "x" })
        const lines = Deno.readTextFileSync(paths.coldStorageStreamFile(stream)).trim().split("\n")
        assertEquals(lines.length, 1)
        assertEquals(JSON.parse(lines[0]).kind, "fire")
    }
})

Deno.test("an unknown stream is still rejected", () => {
    let threw = false
    try {
        coldStorage.appendColdEntry("nonsense", {})
    } catch (_e) {
        threw = true
    }
    assert(threw)
})
