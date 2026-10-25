// tests/timer-registry-test.js — long-delay timers must not overflow setTimeout
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { FakeTime } from "https://deno.land/std@0.224.0/testing/time.ts"
import { setScheduleTimer, listActiveTimers, _resetForTest, MAX_TIMEOUT_MS } from "../lib/scheduler/timer-registry.js"

const DAY_MS = 24 * 60 * 60 * 1000

Deno.test("setScheduleTimer: a monthly delay (> 2^31 ms) waits the full month", () => {
    const time = new FakeTime()
    try {
        let fired = 0
        setScheduleTimer("monthly", new Date(Date.now() + 31 * DAY_MS), () => { fired++ })
        time.tick(1000)
        assertEquals(fired, 0)
        time.tick(MAX_TIMEOUT_MS)
        assertEquals(fired, 0)
        assertEquals(listActiveTimers(), ["monthly"])
        time.tick(31 * DAY_MS - MAX_TIMEOUT_MS - 1000 - 1)
        assertEquals(fired, 0)
        time.tick(1)
        assertEquals(fired, 1)
        assertEquals(listActiveTimers(), [])
    } finally {
        _resetForTest()
        time.restore()
    }
})

Deno.test("setScheduleTimer: a short delay fires once at its time", () => {
    const time = new FakeTime()
    try {
        let fired = 0
        setScheduleTimer("short", new Date(Date.now() + 5000), () => { fired++ })
        time.tick(4999)
        assertEquals(fired, 0)
        time.tick(1)
        assertEquals(fired, 1)
    } finally {
        _resetForTest()
        time.restore()
    }
})
