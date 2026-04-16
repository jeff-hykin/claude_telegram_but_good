// tests/scheduler-test.js — pure scheduler unit tests
import { assertEquals, assert, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { validateRule, computeNextFire } from "../lib/scheduler/index.js"

// ── validateRule ───────────────────────────────────────────────────

Deno.test("validateRule: accepts a daily rule with tzid", () => {
    const out = validateRule({ freq: "DAILY", byhour: [15], byminute: [0], tzid: "America/Los_Angeles" })
    assertEquals(out.ok, true)
})

Deno.test("validateRule: rejects missing freq", () => {
    const out = validateRule({ byhour: [9] })
    assertEquals(out.ok, false)
    assert(/freq/i.test(out.error))
})

Deno.test("validateRule: rejects unknown freq", () => {
    const out = validateRule({ freq: "FORTNIGHTLY" })
    assertEquals(out.ok, false)
})

Deno.test("validateRule: rejects out-of-range byhour", () => {
    const out = validateRule({ freq: "DAILY", byhour: [25] })
    assertEquals(out.ok, false)
})

Deno.test("validateRule: rejects invalid byday", () => {
    const out = validateRule({ freq: "WEEKLY", byday: ["XX"] })
    assertEquals(out.ok, false)
})

Deno.test("validateRule: rejects bad tzid", () => {
    const out = validateRule({ freq: "DAILY", tzid: "Not/A_Real_Zone" })
    assertEquals(out.ok, false)
})

Deno.test("validateRule: accepts interval-only minutely rule", () => {
    const out = validateRule({ freq: "MINUTELY", interval: 30 })
    assertEquals(out.ok, true)
})

Deno.test("validateRule: rejects non-positive interval", () => {
    const out = validateRule({ freq: "DAILY", interval: 0 })
    assertEquals(out.ok, false)
})

// ── computeNextFire ───────────────────────────────────────────────

Deno.test("computeNextFire: daily 15:00 LA produces wall-clock 3pm LA", () => {
    const from = new Date("2026-04-13T12:00:00-07:00") // noon LA
    const rule = { freq: "DAILY", byhour: [15], byminute: [0], tzid: "America/Los_Angeles" }
    const next = computeNextFire(rule, from)
    assert(next instanceof Date)
    // 3pm LA the same day = 22:00 UTC (PDT = UTC-7)
    // Verify the wall clock is 15:00 in LA.
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        hour: "numeric", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(next)
    const hour = Number(parts.find(p => p.type === "hour").value)
    const minute = Number(parts.find(p => p.type === "minute").value)
    assertEquals(hour, 15)
    assertEquals(minute, 0)
})

Deno.test("computeNextFire: daily rule advances past the current time", () => {
    const from = new Date("2026-04-13T22:30:00Z") // 3:30 PM LA (past 15:00)
    const rule = { freq: "DAILY", byhour: [15], byminute: [0], tzid: "America/Los_Angeles" }
    const next = computeNextFire(rule, from)
    assert(next.getTime() > from.getTime())
    // Should be next day
    const deltaHours = (next.getTime() - from.getTime()) / 3600000
    assert(deltaHours > 20 && deltaHours < 30, `delta=${deltaHours}h`)
})

Deno.test("computeNextFire: weekly MO 14:00 NY produces a Monday 2pm NY", () => {
    const from = new Date("2026-04-13T08:00:00-04:00") // Mon 8am NY (Apr 13 2026 is a Monday)
    const rule = { freq: "WEEKLY", byday: ["MO"], byhour: [14], byminute: [0], tzid: "America/New_York" }
    const next = computeNextFire(rule, from)
    assert(next instanceof Date)
    // Verify it lands on a Monday 2pm NY
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        weekday: "short", hour: "numeric", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(next)
    const weekday = parts.find(p => p.type === "weekday").value
    const hour = Number(parts.find(p => p.type === "hour").value)
    assertEquals(weekday, "Mon")
    assertEquals(hour, 14)
})

Deno.test("computeNextFire: interval-only minutely rule fires within 30 min", () => {
    const from = new Date("2026-04-13T12:00:00Z")
    const rule = { freq: "MINUTELY", interval: 30 }
    const next = computeNextFire(rule, from)
    assert(next instanceof Date)
    const delta = next.getTime() - from.getTime()
    assert(delta > 0 && delta <= 30 * 60 * 1000 + 1000, `delta=${delta}ms`)
})

Deno.test("computeNextFire: until in the past returns null", () => {
    const rule = { freq: "DAILY", until: "2024-01-01T00:00:00Z", tzid: "UTC" }
    const next = computeNextFire(rule, new Date("2026-04-13T00:00:00Z"))
    assertEquals(next, null)
})

Deno.test("computeNextFire: throws on invalid rule", () => {
    assertThrows(() => computeNextFire({ freq: "NOPE" }, new Date()), Error)
})
