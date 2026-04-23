// lib/scheduler/index.js
//
// Pure scheduler helpers. Wraps rrule.js for recurrence structure and
// uses luxon to post-correct the tzid footgun (rrule@2.8 treats
// `byhour` as UTC regardless of the tzid field).
//
// The trick:
//   1. Convert `from` from real UTC → "phantom UTC" that represents
//      the wall-clock in tzid. This lets rrule compute occurrences
//      naively without caring about the zone.
//   2. Run rrule WITHOUT its tzid field.
//   3. Convert the returned "phantom UTC" back to real UTC by
//      re-interpreting the wall-clock components in tzid via luxon.
//
// The two functions are pure: no filesystem, no timers, no version.js.

import { RRule, LuxonDateTime } from "../../imports.js"

const FREQ_MAP = {
    YEARLY: RRule.YEARLY,
    MONTHLY: RRule.MONTHLY,
    WEEKLY: RRule.WEEKLY,
    DAILY: RRule.DAILY,
    HOURLY: RRule.HOURLY,
    MINUTELY: RRule.MINUTELY,
    SECONDLY: RRule.SECONDLY,
}

const BYDAY_SET = new Set(["MO", "TU", "WE", "TH", "FR", "SA", "SU"])
const BYDAY_MAP = {
    MO: RRule.MO, TU: RRule.TU, WE: RRule.WE, TH: RRule.TH,
    FR: RRule.FR, SA: RRule.SA, SU: RRule.SU,
}

function inRange(arr, lo, hi) {
    if (!Array.isArray(arr)) { return false }
    return arr.every((n) => Number.isInteger(n) && n >= lo && n <= hi)
}

function isValidTzid(tzid) {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: tzid }).format(new Date())
        return true
    } catch (_) {
        return false
    }
}

/**
 * Validate a rule object. Returns `{ ok: true }` or
 * `{ ok: false, error: "..." }`.
 */
export function validateRule(rule) {
    if (!rule || typeof rule !== "object") {
        return { ok: false, error: "rule must be an object" }
    }
    if (typeof rule.freq !== "string" || !(rule.freq in FREQ_MAP)) {
        return { ok: false, error: `rule.freq must be one of ${Object.keys(FREQ_MAP).join(", ")}` }
    }
    if (rule.interval !== undefined) {
        if (!Number.isInteger(rule.interval) || rule.interval < 1) {
            return { ok: false, error: "rule.interval must be a positive integer" }
        }
    }
    if (rule.byhour !== undefined && !inRange(rule.byhour, 0, 23)) {
        return { ok: false, error: "rule.byhour must be integers in [0,23]" }
    }
    if (rule.byminute !== undefined && !inRange(rule.byminute, 0, 59)) {
        return { ok: false, error: "rule.byminute must be integers in [0,59]" }
    }
    if (rule.bymonth !== undefined && !inRange(rule.bymonth, 1, 12)) {
        return { ok: false, error: "rule.bymonth must be integers in [1,12]" }
    }
    if (rule.bymonthday !== undefined && !inRange(rule.bymonthday, 1, 31)) {
        return { ok: false, error: "rule.bymonthday must be integers in [1,31]" }
    }
    if (rule.byday !== undefined) {
        if (!Array.isArray(rule.byday) || !rule.byday.every((d) => typeof d === "string" && BYDAY_SET.has(d.toUpperCase()))) {
            return { ok: false, error: "rule.byday must be an array of MO/TU/WE/TH/FR/SA/SU" }
        }
    }
    if (rule.count !== undefined) {
        if (!Number.isInteger(rule.count) || rule.count < 1) {
            return { ok: false, error: "rule.count must be a positive integer" }
        }
    }
    if (rule.until !== undefined) {
        const d = new Date(rule.until)
        if (isNaN(d.getTime())) {
            return { ok: false, error: "rule.until must be a parseable ISO timestamp" }
        }
    }
    if (rule.tzid !== undefined && !isValidTzid(rule.tzid)) {
        return { ok: false, error: `rule.tzid "${rule.tzid}" is not a known IANA time zone` }
    }
    return { ok: true }
}

/**
 * Convert a real UTC Date to a "phantom UTC" Date whose UTC components
 * equal the wall-clock components at `realDate` in `tzid`. We feed this
 * to rrule so it generates occurrences in that wall clock naively.
 */
function realToPhantom(realDate, tzid) {
    if (!tzid) { return realDate }
    const dt = LuxonDateTime.fromJSDate(realDate).setZone(tzid)
    return new Date(Date.UTC(
        dt.year, dt.month - 1, dt.day,
        dt.hour, dt.minute, dt.second, dt.millisecond,
    ))
}

/**
 * Inverse of realToPhantom: reinterpret a "phantom UTC" Date's wall
 * clock components as being in tzid and return the real UTC instant.
 */
function phantomToReal(phantomDate, tzid) {
    if (!tzid) { return phantomDate }
    const dt = LuxonDateTime.fromObject({
        year: phantomDate.getUTCFullYear(),
        month: phantomDate.getUTCMonth() + 1,
        day: phantomDate.getUTCDate(),
        hour: phantomDate.getUTCHours(),
        minute: phantomDate.getUTCMinutes(),
        second: phantomDate.getUTCSeconds(),
        millisecond: phantomDate.getUTCMilliseconds(),
    }, { zone: tzid })
    return dt.toJSDate()
}

function toRRuleOptions(rule, dtstart) {
    const opts = {
        freq: FREQ_MAP[rule.freq],
        dtstart,
    }
    if (rule.interval !== undefined) { opts.interval = rule.interval }
    if (rule.byhour !== undefined) { opts.byhour = rule.byhour }
    if (rule.byminute !== undefined) { opts.byminute = rule.byminute }
    if (rule.bymonth !== undefined) { opts.bymonth = rule.bymonth }
    if (rule.bymonthday !== undefined) { opts.bymonthday = rule.bymonthday }
    if (rule.byday !== undefined) { opts.byweekday = rule.byday.map((d) => BYDAY_MAP[d.toUpperCase()]) }
    if (rule.count !== undefined) { opts.count = rule.count }
    if (rule.until !== undefined) { opts.until = new Date(rule.until) }
    // Deliberately NOT passing rule.tzid — we handle it via luxon
    // post-correction to work around rrule@2.8's tzid bug.
    return opts
}

/**
 * Compute the next fire time after `from`. Returns a Date or null if
 * the rule is exhausted (count/until rolled past).
 *
 * By default uses strict "after" (exclusive). Pass `inclusive: true`
 * to include an occurrence exactly at `from` — needed for the initial
 * timer set where dtstart = from, otherwise count-limited rules
 * (e.g. count=1) are immediately exhausted.
 *
 * Throws if the rule fails validation.
 */
/**
 * Estimate the interval duration in milliseconds for a recurrence rule.
 * Used to derive per-task worker budgets (budget = interval duration).
 * Returns null for rules that don't have a simple periodic interval
 * (e.g. MONTHLY with bymonthday — those vary). Falls back to null so
 * callers can use a default.
 */
export function computeIntervalMs(rule) {
    const check = validateRule(rule)
    if (!check.ok) { return null }
    const interval = rule.interval ?? 1
    const MS = {
        SECONDLY: 1000,
        MINUTELY: 60 * 1000,
        HOURLY: 60 * 60 * 1000,
        DAILY: 24 * 60 * 60 * 1000,
        WEEKLY: 7 * 24 * 60 * 60 * 1000,
    }
    const base = MS[rule.freq]
    if (!base) { return null } // MONTHLY/YEARLY vary too much
    return base * interval
}

export function computeNextFire(rule, from, { inclusive = false } = {}) {
    const check = validateRule(rule)
    if (!check.ok) {
        throw new Error(`invalid rule: ${check.error}`)
    }
    const fromDate = from instanceof Date ? from : new Date(from)
    if (isNaN(fromDate.getTime())) {
        throw new Error("from must be a Date or parseable timestamp")
    }

    // Early exit: if `until` is in the past, we're done.
    if (rule.until) {
        const untilDate = new Date(rule.until)
        if (untilDate.getTime() < fromDate.getTime()) {
            return null
        }
    }

    const phantomFrom = realToPhantom(fromDate, rule.tzid)
    const opts = toRRuleOptions(rule, phantomFrom)
    const r = new RRule(opts)
    const phantomNext = r.after(phantomFrom, inclusive)
    if (!phantomNext) { return null }
    return phantomToReal(phantomNext, rule.tzid)
}
