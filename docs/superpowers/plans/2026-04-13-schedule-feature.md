# /schedule feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/schedule` feature to CBG that lets users define recurring tasks with RRULE-based schedules, fires headless `claude --no-tele` workers inside dtach at each tick, critic-monitors each run against a definition of done, and sends the result to Telegram when certified.

**Architecture:** Two-phase drafting (mirrors `/task`): user types `/schedule <description>`, focused worker drafts a DoD + rrule.js-compatible rule object, calls new MCP tool `submit_scheduled_task_definition` to lock. Scheduler stores in `specialData.scheduledTaskByChatId`, schedules in-process `setTimeout` against computed next-fire. On fire, spawn a fresh `claude --no-tele` session in dtach (hidden from CBG shim registry, invisible to `/list`). Worker cwd = task dir. Watch dtach log stability + `report.md` appearance; spawn the existing critic subprocess against the per-run subdir; on verdict, inject revisions via `dtach -p` or kill the session and send the Telegram summary via `send_text_to_user`.

**Tech Stack:** Deno/JS, rrule.js (via esm.sh), dtach, existing CBG event-loop + critic subprocess infrastructure.

**Spec:** [`docs/superpowers/specs/2026-04-13-schedule-feature-design.md`](../specs/2026-04-13-schedule-feature-design.md)

---

## File Map

**Create:**
- `lib/scheduler/index.js` — pure functions: `validateRule(rule)`, `computeNextFire(rule, fromIsoOrDate)`
- `lib/scheduler/timer-registry.js` — module-level singleton `Map<taskId, timerId>` + set/clear/listActive
- `lib/effects/schedule-timer.js` — `scheduleTimerSet`, `scheduleTimerClear` effects
- `lib/effects/scheduled-task-worker.js` — `spawnScheduledTaskWorker`, `killScheduledTaskWorker`, `injectScheduledTaskRevision` effects
- `lib/scheduled-task-actions.js` — pure helpers: `findScheduledTask`, `scheduleCommandLinks`, `buildScheduleCancelAction`
- `lib/event-handlers/scheduled-task-definition-submitted.js`
- `lib/event-handlers/scheduled-task-fire.js`
- `lib/event-handlers/scheduled-task-run-complete.js`
- `tests/scheduler-test.js`
- `tests/handler-scheduled-task-test.js`

**Modify:**
- `imports.js` — add `rrule.js` esm.sh import
- `lib/paths.js` — add `SCHEDULED_TASKS_DIR`, `scheduledTaskDir(id)`, `scheduledTaskRunDir(id, iso)`
- `lib/config-manager.js` — add `getScheduleDefaultTz/setScheduleDefaultTz`, `getScheduleWorkerTimeoutMs`, `getScheduleCriticMaxRetries`
- `event-generators/mcp-server/mcp-shim-tool-handler.js` — add `submit_scheduled_task_definition` tool + IPC path
- `lib/pure/ipc-inbound.js` — translate new IPC message type
- `lib/main-event-processor.js` — register new handlers + effect types
- `lib/event-handlers/chat-user.js` — add `/schedule <desc>` dispatch and `/schedule_*_<id>` dynamic regex handlers
- `lib/effects/critic-subprocess.js` — accept scheduled-run targets (alternate lookup path)
- `lib/event-handlers/critic-verdict.js` — branch for scheduled-run verdicts
- `main-server.js` — on startup, rehydrate timers from `specialData.scheduledTaskByChatId`; detect orphaned `currentRun` entries
- `commands/cron.js` — render CBG-managed scheduled tasks from specialData
- `tests/_helpers.js` — add `SCHEDULED_TASKS_DIR` to the temp-path setup

---

## Task 1: Add rrule.js dependency

**Files:**
- Modify: `imports.js`

- [ ] **Step 1: Add rrule.js import.**

In `imports.js`, add after the `timeago` export block:

```js
// === rrule.js (RFC 5545 recurrence rules) ===
// Parse/compute next-fire from rrule JSON options. Supports tzid via
// the options.tzid field. Accepts option objects (not just iCal strings).
// Docs: https://github.com/jkbrzt/rrule
export { RRule, RRuleSet, rrulestr } from "https://esm.sh/rrule@2.8.1"
```

- [ ] **Step 2: Smoke-test the import from the repo root.**

Run:
```bash
cd /Users/jeffhykin/repos/cbg1 && deno eval 'import("./imports.js").then(m => { const r = new m.RRule({ freq: m.RRule.DAILY, byhour: [15], byminute: [0], tzid: "America/Los_Angeles", dtstart: new Date() }); console.log("next:", r.after(new Date(), true)) })'
```

Expected: prints a Date roughly at the next 3pm LA, no errors. If esm.sh 404s or the version is stale, use the next working minor (`2.8.0` / `2.7.2`).

- [ ] **Step 3: Commit.**

```bash
git add imports.js
git commit -m "deps: add rrule.js for schedule feature"
```

---

## Task 2: Add path helpers for scheduled tasks

**Files:**
- Modify: `lib/paths.js`
- Modify: `tests/_helpers.js`

- [ ] **Step 1: Read lib/paths.js to find the LONG_TASKS_DIR block.**

Locate the existing `LONG_TASKS_DIR = join(cbgDir, "long-tasks")` line and the `longTaskDir` helper below it.

- [ ] **Step 2: Add SCHEDULED_TASKS_DIR + helpers.**

In `lib/paths.js`, next to the long-tasks block, add:

```js
    const SCHEDULED_TASKS_DIR = join(cbgDir, "scheduled-tasks")
    const scheduledTaskDir = (id) => join(SCHEDULED_TASKS_DIR, id)
    const scheduledTaskRunDir = (id, iso) => join(SCHEDULED_TASKS_DIR, id, "runs", iso)
    const scheduledTaskDtachSock = (id, iso) => join(SCHEDULED_TASKS_DIR, id, "runs", iso, "dtach.sock")
    const scheduledTaskDtachLog  = (id, iso) => join(SCHEDULED_TASKS_DIR, id, "runs", iso, "dtach.log")
```

Add all four names to the returned `paths` object and to the named export list at the bottom of `buildPaths`.

- [ ] **Step 3: Extend tests/_helpers.js setupTempPaths.**

In `tests/_helpers.js`, locate the `setupTempPaths` function and add after `Deno.mkdirSync(paths.LONG_TASKS_DIR, { recursive: true })`:

```js
    Deno.mkdirSync(paths.SCHEDULED_TASKS_DIR, { recursive: true })
```

- [ ] **Step 4: Run the existing test suite to confirm nothing broke.**

```bash
cd /Users/jeffhykin/repos/cbg1 && deno test tests/ --allow-all 2>&1 | tail -10
```

Expected: no new failures; existing tests still pass.

- [ ] **Step 5: Commit.**

```bash
git add lib/paths.js tests/_helpers.js
git commit -m "paths: add scheduledTaskDir/Run/Sock/Log helpers"
```

---

## Task 3: Pure scheduler module with tests

**Files:**
- Create: `lib/scheduler/index.js`
- Create: `tests/scheduler-test.js`

- [ ] **Step 1: Write the failing tests first.**

Create `tests/scheduler-test.js`:

```js
// tests/scheduler-test.js — pure scheduler unit tests
import { assertEquals, assertThrows, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { validateRule, computeNextFire } from "../lib/scheduler/index.js"

// ── validateRule ───────────────────────────────────────────────────

Deno.test("validateRule: accepts a daily rule with tzid", () => {
    const rule = { freq: "DAILY", byhour: [15], byminute: [0], tzid: "America/Los_Angeles" }
    const out = validateRule(rule)
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

// ── computeNextFire ───────────────────────────────────────────────

Deno.test("computeNextFire: daily 15:00 LA produces a future Date", () => {
    const from = new Date("2026-04-13T12:00:00-07:00")
    const rule = { freq: "DAILY", byhour: [15], byminute: [0], tzid: "America/Los_Angeles" }
    const next = computeNextFire(rule, from)
    assert(next instanceof Date)
    assert(next.getTime() > from.getTime())
    // should be within 24h
    assert(next.getTime() - from.getTime() < 25 * 60 * 60 * 1000)
})

Deno.test("computeNextFire: weekly MO 14:00 NY", () => {
    const from = new Date("2026-04-13T00:00:00-04:00") // Mon
    const rule = { freq: "WEEKLY", byday: ["MO"], byhour: [14], byminute: [0], tzid: "America/New_York" }
    const next = computeNextFire(rule, from)
    assert(next instanceof Date)
    // either later today or next monday
    assert(next.getTime() >= from.getTime())
})

Deno.test("computeNextFire: interval-only minutely rule", () => {
    const from = new Date("2026-04-13T12:00:00Z")
    const rule = { freq: "MINUTELY", interval: 30 }
    const next = computeNextFire(rule, from)
    assert(next instanceof Date)
    const delta = next.getTime() - from.getTime()
    assert(delta > 0 && delta <= 30 * 60 * 1000 + 1000)
})

Deno.test("computeNextFire: exhausted count returns null", () => {
    const from = new Date("2026-04-13T12:00:00Z")
    const rule = { freq: "DAILY", count: 1, tzid: "UTC" }
    // First fire is today; ask for a next fire far in the future
    const next = computeNextFire(rule, new Date("2027-01-01T00:00:00Z"))
    assertEquals(next, null)
})

Deno.test("computeNextFire: until in the past returns null", () => {
    const rule = { freq: "DAILY", until: "2024-01-01T00:00:00Z", tzid: "UTC" }
    const next = computeNextFire(rule, new Date("2026-04-13T00:00:00Z"))
    assertEquals(next, null)
})
```

- [ ] **Step 2: Run the tests to confirm they fail.**

```bash
cd /Users/jeffhykin/repos/cbg1 && deno test tests/scheduler-test.js --allow-all 2>&1 | tail -20
```

Expected: FAIL — module not found at `lib/scheduler/index.js`.

- [ ] **Step 3: Implement lib/scheduler/index.js.**

Create `lib/scheduler/index.js`:

```js
// lib/scheduler/index.js
//
// Pure scheduler helpers. Wraps rrule.js to compute next-fire times
// from a JSON rule object. Rules are rrule.js option objects plus a
// required `freq` string, optional `tzid`, and the usual RFC 5545
// byhour/byminute/byday/bymonth/bymonthday/interval/count/until fields.
//
// Both functions are pure — no filesystem, no timers, no imports from
// ./version.js. Safe to call from handlers, effects, and tests alike.

import { RRule } from "../../imports.js"

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
        // Intl throws a RangeError on an unknown time zone.
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
 * Build an rrule.js options object from our JSON shape.
 */
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
    if (rule.tzid !== undefined) { opts.tzid = rule.tzid }
    return opts
}

/**
 * Compute the next fire time strictly AFTER `from`. Returns a Date or
 * null if the rule is exhausted (count/until rolled past).
 *
 * The rule's implicit dtstart is `from` if none is carried on the
 * rule itself; this makes "fire next at the next daily 15:00 LA"
 * trivially interpretable without the caller having to track the
 * original creation time.
 */
export function computeNextFire(rule, from) {
    const check = validateRule(rule)
    if (!check.ok) {
        throw new Error(`invalid rule: ${check.error}`)
    }
    const fromDate = from instanceof Date ? from : new Date(from)
    if (isNaN(fromDate.getTime())) {
        throw new Error("from must be a Date or parseable timestamp")
    }
    const opts = toRRuleOptions(rule, fromDate)
    const r = new RRule(opts)
    const next = r.after(fromDate, false /* inclusive=false */)
    return next ?? null
}
```

- [ ] **Step 4: Run the tests and confirm they pass.**

```bash
cd /Users/jeffhykin/repos/cbg1 && deno test tests/scheduler-test.js --allow-all 2>&1 | tail -20
```

Expected: all 11 tests pass. If any fail (e.g. rrule.js surfacing `after()` in UTC when you asked for LA tzid), add a DST-aware normalization pass before returning the Date. The DST behavior of rrule.js is the one real subtlety here — double-check `next` is a real wall-clock Date in the requested tz.

- [ ] **Step 5: Commit.**

```bash
git add lib/scheduler/index.js tests/scheduler-test.js
git commit -m "scheduler: pure validateRule + computeNextFire via rrule.js"
```

---

## Task 4: Config helpers for schedule feature

**Files:**
- Modify: `lib/config-manager.js`

- [ ] **Step 1: Read the existing getter/setter pattern in config-manager.js.**

Find an existing pair like `getCriticModel` / `setCriticModel` and follow that shape.

- [ ] **Step 2: Add schedule config helpers.**

Append to `lib/config-manager.js`:

```js
// ── schedule feature ────────────────────────────────────────────────

/**
 * Return the user's default timezone for scheduled tasks (or null).
 * If set, the drafting agent uses it silently and echoes the choice
 * in its confirmation message; if null, the agent must ask explicitly
 * when a time-of-day is specified without context.
 */
export function getScheduleDefaultTz() {
    return getConfig("schedule.default_tz") ?? null
}

export function setScheduleDefaultTz(tzid) {
    return setConfig("schedule.default_tz", tzid)
}

/**
 * Wall-clock cap for a single scheduled-task run. Default: 15 min.
 */
export function getScheduleWorkerTimeoutMs() {
    const v = getConfig("schedule.worker_timeout_ms")
    return Number.isFinite(v) && v > 0 ? v : 15 * 60 * 1000
}

/**
 * Max critic retries per run (same as long-task default). Default: 3.
 */
export function getScheduleCriticMaxRetries() {
    const v = getConfig("schedule.critic_max_retries")
    return Number.isInteger(v) && v >= 1 ? v : 3
}
```

If `getConfig` / `setConfig` use a different accessor style (e.g., dot paths vs. flat keys), match the existing convention used for `critic_model` etc.

- [ ] **Step 3: Smoke check — does Deno still parse the file?**

```bash
cd /Users/jeffhykin/repos/cbg1 && deno check lib/config-manager.js
```

Expected: no errors.

- [ ] **Step 4: Commit.**

```bash
git add lib/config-manager.js
git commit -m "config: schedule.default_tz, worker_timeout_ms, critic_max_retries helpers"
```

---

## Task 5: Timer registry + schedule_timer effects

**Files:**
- Create: `lib/scheduler/timer-registry.js`
- Create: `lib/effects/schedule-timer.js`

- [ ] **Step 1: Create the timer registry.**

Create `lib/scheduler/timer-registry.js`:

```js
// lib/scheduler/timer-registry.js
//
// Module-level Map<scheduleTaskId, timerHandle>. Lives outside of
// `core` because setTimeout handles are inherently imperative in-process
// resources that don't belong in the persisted state tree. Timer state
// is rebuilt on every daemon startup from specialData (see
// main-server.js's rehydrateScheduledTimers).

import { versionedImport } from "../version.js"
const { dbg } = await versionedImport("../logging.js", import.meta)

const timers = new Map()

export function setScheduleTimer(taskId, fireAtDate, onFire) {
    clearScheduleTimer(taskId)
    const delayMs = Math.max(0, fireAtDate.getTime() - Date.now())
    const handle = setTimeout(() => {
        timers.delete(taskId)
        try {
            onFire()
        } catch (e) {
            dbg("SCHED-TIMER", `onFire threw for ${taskId}:`, e)
        }
    }, delayMs)
    timers.set(taskId, handle)
    dbg("SCHED-TIMER", `set ${taskId} to fire in ${delayMs}ms`)
}

export function clearScheduleTimer(taskId) {
    const handle = timers.get(taskId)
    if (handle !== undefined) {
        clearTimeout(handle)
        timers.delete(taskId)
        dbg("SCHED-TIMER", `cleared ${taskId}`)
    }
}

export function listActiveTimers() {
    return Array.from(timers.keys())
}

export function _resetForTest() {
    for (const h of timers.values()) { clearTimeout(h) }
    timers.clear()
}
```

- [ ] **Step 2: Create the schedule-timer effect module.**

Create `lib/effects/schedule-timer.js`:

```js
// lib/effects/schedule-timer.js
//
// Effects that register / clear in-process schedule timers. Timer
// state lives in lib/scheduler/timer-registry.js (not on core) because
// setTimeout handles aren't serializable. When a timer fires, it
// enqueues a `scheduled_task_fire` event through core.enqueueEvent.

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { computeNextFire } = await versionedImport("../scheduler/index.js", import.meta)
const { setScheduleTimer, clearScheduleTimer } = await versionedImport("../scheduler/timer-registry.js", import.meta)

/**
 * effect shape: { type: "schedule_timer_set", chatId, scheduleTaskId, rule, from? }
 *
 * Computes the next fire time from `rule` and `from` (defaults to
 * now), then registers a setTimeout that enqueues a
 * `scheduled_task_fire` event when it fires. If the rule is exhausted
 * (count/until past), no timer is set and the task is expected to
 * transition to terminal state by the caller.
 *
 * Returns a `{ stateChanges }` patch recording `tracking.nextFireAt`
 * (advisory) so /schedule_status can show it without recomputing.
 */
export async function scheduleTimerSet(effect, core) {
    const { chatId, scheduleTaskId, rule, from } = effect
    if (!chatId || !scheduleTaskId || !rule) {
        dbg("SCHED-TIMER", "schedule_timer_set: missing chatId/scheduleTaskId/rule")
        return
    }
    let next
    try {
        next = computeNextFire(rule, from ?? new Date())
    } catch (e) {
        dbg("SCHED-TIMER", `computeNextFire threw for ${scheduleTaskId}:`, e)
        return
    }
    if (!next) {
        dbg("SCHED-TIMER", `rule exhausted for ${scheduleTaskId}; no timer set`)
        return {
            stateChanges: {
                specialData: {
                    scheduledTaskByChatId: {
                        [chatId]: {
                            [scheduleTaskId]: {
                                tracking: { nextFireAt: null },
                                state: "completed",
                            },
                        },
                    },
                },
            },
        }
    }

    const nextIso = next.toISOString()
    setScheduleTimer(scheduleTaskId, next, () => {
        try {
            core.enqueueEvent?.({
                type: "scheduled_task_fire",
                chatId,
                scheduleTaskId,
                fireIso: nextIso,
            })
        } catch (e) {
            dbg("SCHED-TIMER", `enqueue on fire threw for ${scheduleTaskId}:`, e)
        }
    })

    return {
        stateChanges: {
            specialData: {
                scheduledTaskByChatId: {
                    [chatId]: {
                        [scheduleTaskId]: {
                            tracking: { nextFireAt: nextIso },
                        },
                    },
                },
            },
        },
    }
}

/**
 * effect shape: { type: "schedule_timer_clear", scheduleTaskId }
 */
export async function scheduleTimerClear(effect, _core) {
    const { scheduleTaskId } = effect
    if (!scheduleTaskId) { return }
    clearScheduleTimer(scheduleTaskId)
}
```

- [ ] **Step 3: Commit.**

```bash
git add lib/scheduler/timer-registry.js lib/effects/schedule-timer.js
git commit -m "scheduler: timer registry + schedule_timer_set/clear effects"
```

---

## Task 6: Pure action helpers for scheduled tasks

**Files:**
- Create: `lib/scheduled-task-actions.js`

- [ ] **Step 1: Create the helper module.**

Create `lib/scheduled-task-actions.js`:

```js
// lib/scheduled-task-actions.js
//
// Pure helpers for the /schedule feature, mirroring lib/long-task-actions.js.
// Used by chat-user.js, commands/cron.js, and event handlers.

import { versionedImport } from "./version.js"
const { escapeHtml: esc } = await versionedImport("./pure/html.js", import.meta)

/**
 * Find a scheduled task by id across all chats. Returns
 * `{ chatId, task }` or null.
 */
export function findScheduledTask(specialData, scheduleTaskId) {
    const byChat = specialData?.scheduledTaskByChatId ?? {}
    for (const [chatId, tasks] of Object.entries(byChat)) {
        if (tasks && tasks[scheduleTaskId] !== undefined) {
            return { chatId, task: tasks[scheduleTaskId] }
        }
    }
    return null
}

/**
 * Render the standard inline command row for a scheduled task.
 */
export function scheduleCommandLinks(scheduleTaskId) {
    const id = esc(scheduleTaskId)
    return [
        `/schedule_status_${id}`,
        `/schedule_view_${id}`,
        `/schedule_pause_${id}`,
        `/schedule_cancel_${id}`,
    ].join("   ")
}

/**
 * Build an Action that cancels a scheduled task. Marks it terminal,
 * clears the timer, logs to cold storage, sends a confirmation.
 */
export function buildScheduleCancelAction(core, chatId, scheduleTaskId) {
    const found = findScheduledTask(core.specialData, scheduleTaskId)
    if (!found) {
        return {
            effects: [
                {
                    type: "send_text_to_user",
                    chatId,
                    text: `Unknown scheduled task: <code>${esc(scheduleTaskId)}</code>`,
                    options: { parse_mode: "HTML" },
                },
            ],
        }
    }
    const task = found.task
    if (task.state === "cancelled") {
        return {
            effects: [
                {
                    type: "send_text_to_user",
                    chatId,
                    text: `Scheduled task <code>${esc(scheduleTaskId)}</code> is already cancelled.`,
                    options: { parse_mode: "HTML" },
                },
            ],
        }
    }
    return {
        stateChanges: {
            specialData: {
                scheduledTaskByChatId: {
                    [chatId]: {
                        [scheduleTaskId]: {
                            state: "cancelled",
                            currentRun: undefined, // delete dangling current-run pointer
                        },
                    },
                },
            },
        },
        effects: [
            { type: "schedule_timer_clear", scheduleTaskId },
            {
                type: "cold_append",
                stream: "scheduled-tasks",
                entry: { scheduleTaskId, chatId, event: "cancelled" },
            },
            {
                type: "send_text_to_user",
                chatId,
                text: `Cancelled scheduled task <code>${esc(scheduleTaskId)}</code>.`,
                options: { parse_mode: "HTML" },
            },
        ],
    }
}
```

- [ ] **Step 2: Deno-check the file.**

```bash
cd /Users/jeffhykin/repos/cbg1 && deno check lib/scheduled-task-actions.js
```

Expected: no errors.

- [ ] **Step 3: Commit.**

```bash
git add lib/scheduled-task-actions.js
git commit -m "scheduled-tasks: pure helpers (find, command-links, cancel action)"
```

---

## Task 7: MCP tool surface for submit_scheduled_task_definition

**Files:**
- Modify: `event-generators/mcp-server/mcp-shim-tool-handler.js`
- Modify: `lib/pure/ipc-inbound.js`

- [ ] **Step 1: Add the new tool to the TOOLS export.**

In `event-generators/mcp-server/mcp-shim-tool-handler.js`, inside the `TOOLS` array, after the `submit_long_task_definition` entry, add:

```js
    {
        name: "submit_scheduled_task_definition",
        description: "Submit the definition of done AND the recurrence rule for a scheduled task. Call this after clarifying the schedule and definition with the user. Fails if the scheduled task is not in state 'defining' or the session doesn't own it.",
        inputSchema: {
            type: "object",
            properties: {
                scheduleTaskId: { type: "string" },
                rule: {
                    type: "object",
                    description: "rrule.js option object: { freq: DAILY|WEEKLY|MONTHLY|YEARLY|HOURLY|MINUTELY, interval?, byhour?, byminute?, byday?, bymonth?, bymonthday?, count?, until?, tzid? }. Timezone in tzid (IANA string).",
                },
                definitionOfDone: { type: "string", description: "Markdown definition of done, including the explicit output file path the worker should write each run." },
                title: { type: "string", description: "Optional short display title." },
            },
            required: ["scheduleTaskId", "rule", "definitionOfDone"],
        },
    },
```

- [ ] **Step 2: Add the IPC dispatch branch in handleToolCall.**

In the same file, locate the `if (name === "submit_long_task_definition")` block and add below it:

```js
    } else if (name === "submit_scheduled_task_definition") {
        ipcMessage = {
            type: "scheduled_task_definition_submitted",
            sessionId,
            requestId,
            scheduleTaskId: args.scheduleTaskId,
            rule: args.rule,
            definitionOfDone: args.definitionOfDone,
            title: args.title,
        }
```

- [ ] **Step 3: Translate it on the server side in ipc-inbound.js.**

In `lib/pure/ipc-inbound.js`, find the `long_task_definition_submitted` case in `translateIpcMessage` and add an analogous case below it:

```js
    if (msg.type === "scheduled_task_definition_submitted") {
        return [{
            type: "scheduled_task_definition_submitted",
            sessionId: msg.sessionId,
            requestId: msg.requestId,
            scheduleTaskId: msg.scheduleTaskId,
            rule: msg.rule,
            definitionOfDone: msg.definitionOfDone,
            title: msg.title ?? null,
            _conn: conn,
        }]
    }
```

- [ ] **Step 4: Commit.**

```bash
git add event-generators/mcp-server/mcp-shim-tool-handler.js lib/pure/ipc-inbound.js
git commit -m "mcp: submit_scheduled_task_definition tool + ipc translator"
```

---

## Task 8: scheduled-task-definition-submitted handler + tests

**Files:**
- Create: `lib/event-handlers/scheduled-task-definition-submitted.js`
- Create: `tests/handler-scheduled-task-test.js` (shared test file for all scheduled-task handlers)

- [ ] **Step 1: Write failing tests.**

Create `tests/handler-scheduled-task-test.js`:

```js
// tests/handler-scheduled-task-test.js
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

Deno.test("schedule-submit: invalid event (empty definition) rejects", () => {
    const core = coreWithTask(baseDefining())
    const action = submit({
        scheduleTaskId: "s1",
        rule: { freq: "DAILY", byhour: [15], tzid: "America/Los_Angeles" },
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
        rule: { freq: "DAILY", byhour: [15], tzid: "America/Los_Angeles" },
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
        rule: { freq: "DAILY", byhour: [15], tzid: "America/Los_Angeles" },
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
        rule: { freq: "DAILY", byhour: [15], tzid: "America/Los_Angeles" },
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

Deno.test("schedule-submit: valid submission locks + emits schedule_timer_set + write_file + cold_append + user message", () => {
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
    // draftingSessionId cleared
    assertEquals(patch.draftingSessionId, undefined)
    // Effects include: ipc_respond(ok), write_file(definition_of_done.md),
    // cold_append, schedule_timer_set, send_text_to_user
    assert(effectsOfType(action, "schedule_timer_set").length === 1)
    assert(effectsOfType(action, "write_file").length >= 1)
    assert(effectsOfType(action, "cold_append").length === 1)
    assert(effectsOfType(action, "send_text_to_user").length === 1)
    const ipc = effectsOfType(action, "ipc_respond")[0]
    assertEquals(ipc.message.result.isError, undefined)
})
```

- [ ] **Step 2: Run tests; expect failure.**

```bash
cd /Users/jeffhykin/repos/cbg1 && deno test tests/handler-scheduled-task-test.js --allow-all 2>&1 | tail -20
```

Expected: FAIL — handler module does not exist.

- [ ] **Step 3: Implement the handler.**

Create `lib/event-handlers/scheduled-task-definition-submitted.js`:

```js
// lib/event-handlers/scheduled-task-definition-submitted.js
//
// Handler for the MCP tool submit_scheduled_task_definition. Mirrors
// long-task-definition-submitted.js: validates, locks the task in
// state "scheduled", writes a definition_of_done.md to the task
// directory, emits a schedule_timer_set to register the first fire,
// logs, and replies to the caller.

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { paths } = await versionedImport("../paths.js", import.meta)
const { validateRule } = await versionedImport("../scheduler/index.js", import.meta)
const { findScheduledTask, scheduleCommandLinks } = await versionedImport("../scheduled-task-actions.js", import.meta)
const { escapeHtml: esc } = await versionedImport("../pure/html.js", import.meta)
const { join } = await versionedImport("../../imports.js", import.meta)

function replyError(event, message) {
    return {
        effects: [
            {
                type: "ipc_respond",
                conn: event._conn,
                message: {
                    type: "tool_response",
                    requestId: event.requestId,
                    result: {
                        content: [{ type: "text", text: message }],
                        isError: true,
                    },
                },
            },
        ],
    }
}

export default function handle(event, core) {
    const { scheduleTaskId, sessionId, rule, definitionOfDone, title } = event

    if (!scheduleTaskId || typeof definitionOfDone !== "string" || !definitionOfDone.trim()) {
        dbg("SCHED-SUB", `invalid event: scheduleTaskId=${scheduleTaskId} definition=${!!definitionOfDone}`)
        return replyError(event, "invalid request: scheduleTaskId and non-empty definitionOfDone are required")
    }

    const found = findScheduledTask(core.specialData, scheduleTaskId)
    if (!found) {
        return replyError(event, `scheduled task ${scheduleTaskId} not found`)
    }
    const { chatId, task } = found

    if (task.draftingSessionId !== sessionId) {
        return replyError(
            event,
            `session mismatch: scheduled task is owned by ${task.draftingSessionId}, not ${sessionId}`,
        )
    }
    if (task.state !== "defining") {
        return replyError(event, `scheduled task ${scheduleTaskId} is in state "${task.state}", not "defining"`)
    }

    const check = validateRule(rule)
    if (!check.ok) {
        return replyError(event, `invalid rule: ${check.error}`)
    }

    dbg("SCHED-SUB", `locking scheduled task ${scheduleTaskId}`)

    const taskDir = paths.scheduledTaskDir(scheduleTaskId)
    const defPath = join(taskDir, "definition_of_done.md")
    const rulePath = join(taskDir, "rule.json")

    return {
        stateChanges: {
            specialData: {
                scheduledTaskByChatId: {
                    [chatId]: {
                        [scheduleTaskId]: {
                            state: "scheduled",
                            definitionOfDone,
                            rule,
                            title: title ?? task.title,
                            draftingSessionId: undefined,
                        },
                    },
                },
            },
        },
        effects: [
            { type: "mkdir", path: taskDir },
            { type: "write_file", path: defPath, content: definitionOfDone },
            { type: "write_file", path: rulePath, content: JSON.stringify(rule, null, 2) },
            {
                type: "cold_append",
                stream: "scheduled-tasks",
                entry: {
                    scheduleTaskId,
                    chatId,
                    event: "locked",
                    sessionId,
                    definitionLength: definitionOfDone.length,
                },
            },
            {
                type: "schedule_timer_set",
                chatId,
                scheduleTaskId,
                rule,
            },
            {
                type: "ipc_respond",
                conn: event._conn,
                message: {
                    type: "tool_response",
                    requestId: event.requestId,
                    result: {
                        content: [
                            { type: "text", text: "Scheduled task locked. First fire is registered." },
                        ],
                    },
                },
            },
            {
                type: "send_text_to_user",
                chatId,
                text:
                    `Scheduled task <code>${esc(scheduleTaskId)}</code> locked.\n\n` +
                    scheduleCommandLinks(scheduleTaskId),
                options: { parse_mode: "HTML" },
            },
        ],
    }
}
```

- [ ] **Step 4: Run tests; expect pass.**

```bash
cd /Users/jeffhykin/repos/cbg1 && deno test tests/handler-scheduled-task-test.js --allow-all 2>&1 | tail -20
```

Expected: 6 tests pass.

- [ ] **Step 5: Commit.**

```bash
git add lib/event-handlers/scheduled-task-definition-submitted.js tests/handler-scheduled-task-test.js
git commit -m "handlers: scheduled-task-definition-submitted + tests"
```

---

## Task 9: Worker spawn + kill effects (dtach, --no-tele)

**Files:**
- Create: `lib/effects/scheduled-task-worker.js`

- [ ] **Step 1: Create the worker spawn effect.**

Create `lib/effects/scheduled-task-worker.js`:

```js
// lib/effects/scheduled-task-worker.js
//
// Effects that spawn / inject into / kill the headless scheduled-task
// worker session. The worker is a fresh `claude --no-tele` session
// inside a dtach wrapper. It is NOT registered with CBG's shim
// (invisible to chatSessions and /list). Communication with it is
// entirely through dtach: stdin via `dtach -p`, stdout via the dtach
// log file. When `report.md` appears in the run dir OR the dtach log
// goes idle for STALL_MS, we hand off to the critic via a
// `spawn_critic` effect.

import { writeFileSync, existsSync, readFileSync, statSync, mkdirSync } from "node:fs"
import { versionedImport } from "../version.js"
import { $ } from "../../imports.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { paths } = await versionedImport("../paths.js", import.meta)
const { join } = await versionedImport("../../imports.js", import.meta)
const { getScheduleWorkerTimeoutMs } = await versionedImport("../config-manager.js", import.meta)

// How long the dtach log must be quiet (no new bytes) before we
// consider the worker idle. Used both for the initial "is claude at
// the prompt yet" check and the fallback "worker stalled" trigger.
const LOG_QUIET_MS = 4_000
// How long to poll for readiness before giving up and injecting
// anyway. Claude usually prints its prompt within 3-5 s.
const READINESS_POLL_MS = 500
const READINESS_MAX_MS = 20_000
// How often to check for report.md.
const REPORT_POLL_MS = 1_000

function fileLen(path) {
    try { return statSync(path).size } catch { return 0 }
}

async function waitForDtachReady(logFile, maxMs = READINESS_MAX_MS) {
    const start = Date.now()
    let lastSize = 0
    let lastChange = Date.now()
    while (Date.now() - start < maxMs) {
        const n = fileLen(logFile)
        if (n !== lastSize) {
            lastSize = n
            lastChange = Date.now()
        }
        if (n > 0 && Date.now() - lastChange > LOG_QUIET_MS) {
            return true
        }
        await new Promise((r) => setTimeout(r, READINESS_POLL_MS))
    }
    return false
}

async function dtachInject(sockPath, text) {
    try {
        await $`dtach -p ${sockPath}`.stdinText(text + "\r\n").timeout(5000)
        return true
    } catch (e) {
        dbg("SCHED-WORKER", `dtach -p inject failed for ${sockPath}:`, e)
        return false
    }
}

/**
 * effect shape: {
 *   type: "scheduled_task_worker_spawn",
 *   chatId, scheduleTaskId, runIso,
 * }
 *
 * Spawns the worker, writes instructions.md + prompt, then starts an
 * async watcher coroutine that enqueues `spawn_critic` when report.md
 * appears (or a `scheduled_task_run_complete` with status "errored"
 * when the wall-clock budget runs out).
 *
 * Returns immediately — the watcher runs in the background.
 */
export async function spawnScheduledTaskWorker(effect, core) {
    const { chatId, scheduleTaskId, runIso } = effect
    if (!chatId || !scheduleTaskId || !runIso) {
        dbg("SCHED-WORKER", "spawn: missing required fields")
        return
    }

    const taskDir = paths.scheduledTaskDir(scheduleTaskId)
    const runDir = paths.scheduledTaskRunDir(scheduleTaskId, runIso)
    const sockPath = paths.scheduledTaskDtachSock(scheduleTaskId, runIso)
    const logFile = paths.scheduledTaskDtachLog(scheduleTaskId, runIso)
    const reportPath = join(runDir, "report.md")
    const instructionsPath = join(runDir, "instructions.md")

    // Pre-create run dir
    try { mkdirSync(runDir, { recursive: true }) }
    catch (e) { dbg("SCHED-WORKER", `mkdir runDir:`, e) }

    // Look up the task to build the instructions text.
    const task = core.specialData?.scheduledTaskByChatId?.[chatId]?.[scheduleTaskId]
    if (!task) {
        dbg("SCHED-WORKER", `spawn: task ${scheduleTaskId} not in state`)
        return
    }

    const instructions = [
        `# Scheduled task run`,
        ``,
        `Schedule: ${scheduleTaskId}`,
        `Fire ISO: ${runIso}`,
        `Run dir: ${runDir}`,
        ``,
        `## Definition of done`,
        ``,
        task.definitionOfDone ?? "(missing)",
        ``,
        `## Instructions`,
        ``,
        `1. Complete the work described in the definition of done.`,
        `2. Write your output to \`${reportPath}\` — a critic will independently verify it against the definition of done.`,
        `3. If the critic returns revisions, read \`${join(runDir, "revision_request.md")}\` and update your report.`,
    ].join("\n")

    try { writeFileSync(instructionsPath, instructions) }
    catch (e) { dbg("SCHED-WORKER", `write instructions failed:`, e) }

    // Strip CLAUDE_/MCP_ env (same hygiene as critic-subprocess +
    // commands/new.js).
    const cleanEnv = { ...Deno.env.toObject() }
    for (const key of Object.keys(cleanEnv)) {
        if (key.startsWith("CLAUDE_") || key.startsWith("MCP_")) {
            delete cleanEnv[key]
        }
    }
    cleanEnv.SHELL = "/bin/bash"

    // Build the dtach-wrapped claude invocation. --no-tele bypasses
    // CBG's channel+shim machinery; the session is NOT in
    // core.chatSessions and never registers.
    const claudeCmd = `claude --no-tele --dangerously-skip-permissions`
    const inner = `cd "${taskDir}" && ${claudeCmd}`
    const isDarwin = Deno.build.os === "darwin"

    try {
        const cmd = isDarwin
            ? $`dtach -n ${sockPath} -Ez script -q -F ${logFile} bash -c ${inner}`
            : $`dtach -n ${sockPath} -Ez script -fq -c ${inner} ${logFile}`
        await cmd.clearEnv().env(cleanEnv).timeout(5000).stdout("piped").stderr("piped")
    } catch (e) {
        dbg("SCHED-WORKER", `spawn dtach failed for ${scheduleTaskId}:`, e)
        core.enqueueEvent?.({
            type: "scheduled_task_run_complete",
            chatId, scheduleTaskId, runIso,
            status: "errored",
            summary: `spawn failed: ${String(e).slice(0, 200)}`,
        })
        return
    }

    // Kick off the watcher in the background.
    ;(async () => {
        const started = Date.now()
        const budgetMs = getScheduleWorkerTimeoutMs()

        // Wait for the worker to be ready (log has content and has
        // been quiet for LOG_QUIET_MS). If readiness times out, we
        // still try to inject — the alternative is to bail entirely
        // and we'd rather give the task a chance.
        await waitForDtachReady(logFile)

        // Inject the kickoff.
        const ok = await dtachInject(
            sockPath,
            `Read ./runs/${runIso}/instructions.md and complete the task. The definition of done is in ./definition_of_done.md. When done, write ./runs/${runIso}/report.md.`,
        )
        if (!ok) {
            dbg("SCHED-WORKER", `kickoff inject failed for ${scheduleTaskId}; enqueueing error`)
            core.enqueueEvent?.({
                type: "scheduled_task_run_complete",
                chatId, scheduleTaskId, runIso,
                status: "errored",
                summary: "failed to inject kickoff into worker",
            })
            return
        }

        // Poll for report.md or budget exhaustion.
        while (Date.now() - started < budgetMs) {
            if (existsSync(reportPath)) {
                dbg("SCHED-WORKER", `report.md appeared for ${scheduleTaskId}; spawning critic`)
                // Enqueue a spawn_critic effect via a follow-up event.
                // We emit a critic_verdict-eligible "trigger" event.
                core.enqueueEvent?.({
                    type: "scheduled_task_fire",  // re-enter not wanted; use direct critic path below
                    __route: "critic",  // handler knows to dispatch to critic for this run
                    chatId, scheduleTaskId, runIso,
                })
                // NOTE: `scheduled_task_fire` won't accept `__route`.
                // Use a dedicated event below instead. See Task 10.
                return
            }
            await new Promise((r) => setTimeout(r, REPORT_POLL_MS))
        }

        // Budget exhausted.
        dbg("SCHED-WORKER", `worker budget exhausted for ${scheduleTaskId}`)
        core.enqueueEvent?.({
            type: "scheduled_task_run_complete",
            chatId, scheduleTaskId, runIso,
            status: "errored",
            summary: `worker exceeded ${budgetMs}ms wall-clock budget without producing report.md`,
        })
        // Kill the dtach session directly (no effect) — spawn a
        // shim-free dtach kill since we don't have the core
        // dispatcher in this async context.
        try {
            await $`dtach -p ${sockPath}`.stdinText("\x03\x03\n").timeout(2000)
        } catch (e) { dbg("SCHED-WORKER", "kick SIGINT on budget fail:", e) }
    })().catch((e) => dbg("SCHED-WORKER", "watcher coroutine threw:", e))
}

/**
 * effect shape: { type: "scheduled_task_worker_inject", scheduleTaskId, runIso, text }
 *
 * Waits for dtach log to be quiet, then injects text via dtach -p.
 * Used for revision feedback after a critic verdict.
 */
export async function injectScheduledTaskText(effect, _core) {
    const { scheduleTaskId, runIso, text } = effect
    if (!scheduleTaskId || !runIso || !text) { return }
    const sockPath = paths.scheduledTaskDtachSock(scheduleTaskId, runIso)
    const logFile = paths.scheduledTaskDtachLog(scheduleTaskId, runIso)
    await waitForDtachReady(logFile)
    await dtachInject(sockPath, text)
}

/**
 * effect shape: { type: "scheduled_task_worker_kill", scheduleTaskId, runIso }
 *
 * Sends Ctrl+C repeatedly + exit to gracefully shut down the worker
 * session, then best-effort removes the socket.
 */
export async function killScheduledTaskWorker(effect, _core) {
    const { scheduleTaskId, runIso } = effect
    if (!scheduleTaskId || !runIso) { return }
    const sockPath = paths.scheduledTaskDtachSock(scheduleTaskId, runIso)
    try {
        // Two Ctrl+Cs + explicit exit. claude responds to the first
        // Ctrl+C by cancelling the current request; the second drops
        // you to the shell; `exit` closes dtach.
        await $`dtach -p ${sockPath}`.stdinText("\x03\x03\nexit\n").timeout(3000)
    } catch (e) {
        dbg("SCHED-WORKER", `kill inject failed for ${scheduleTaskId}:`, e)
    }
}
```

**Note on the `__route` hack:** the code above notes inline that reusing `scheduled_task_fire` with a `__route` field is wrong. The proper path is a dedicated follow-up event `scheduled_task_worker_reported_ready` that the next task introduces. For now, leave the placeholder and fix it in Task 10.

- [ ] **Step 2: Commit the scaffold even though it references the follow-up event.**

```bash
git add lib/effects/scheduled-task-worker.js
git commit -m "effects: scheduled-task-worker spawn/inject/kill scaffolding"
```

---

## Task 10: Wire the fire handler + report-ready event

**Files:**
- Create: `lib/event-handlers/scheduled-task-fire.js`
- Modify: `lib/effects/scheduled-task-worker.js` (replace the `__route` hack)
- Modify: `lib/event-handlers/critic-verdict.js` (accept a scheduled-run target in a new branch)
- Modify: `lib/effects/critic-subprocess.js` (alternate lookup path — taskId → scheduledRun)

- [ ] **Step 1: Replace the `__route` hack in scheduled-task-worker.js.**

In `lib/effects/scheduled-task-worker.js`, locate the `// Enqueue a spawn_critic effect via a follow-up event.` block and replace the `core.enqueueEvent(...)` call with:

```js
                core.enqueueEvent?.({
                    type: "scheduled_task_worker_report_ready",
                    chatId, scheduleTaskId, runIso,
                })
                return
```

Remove the `__route` field and the trailing NOTE comment.

- [ ] **Step 2: Create the fire handler.**

Create `lib/event-handlers/scheduled-task-fire.js`:

```js
// lib/event-handlers/scheduled-task-fire.js
//
// Timer fired — kick off a run, unless the task is in a terminal
// state or skipNext is set.

import { versionedImport } from "../version.js"
const { dbg } = await versionedImport("../logging.js", import.meta)
const { findScheduledTask } = await versionedImport("../scheduled-task-actions.js", import.meta)

export default function handle(event, core) {
    const { chatId, scheduleTaskId, fireIso } = event
    const found = findScheduledTask(core.specialData, scheduleTaskId)
    if (!found) {
        dbg("SCHED-FIRE", `task ${scheduleTaskId} not found; swallowing fire`)
        return null
    }
    const task = found.task
    if (task.state === "cancelled" || task.state === "completed" || task.state === "errored") {
        dbg("SCHED-FIRE", `task ${scheduleTaskId} terminal (${task.state}); skipping`)
        return null
    }
    if (task.state === "running") {
        dbg("SCHED-FIRE", `task ${scheduleTaskId} still running a previous fire; skipping`)
        // Rearm for next slot anyway.
        return {
            effects: [
                { type: "schedule_timer_set", chatId, scheduleTaskId, rule: task.rule },
                {
                    type: "cold_append",
                    stream: "scheduled-tasks",
                    entry: { scheduleTaskId, chatId, event: "skipped", reason: "previous run still in progress", fireIso },
                },
            ],
        }
    }
    if (task.tracking?.skipNext) {
        dbg("SCHED-FIRE", `task ${scheduleTaskId} skipNext; clearing and rearming`)
        return {
            stateChanges: {
                specialData: {
                    scheduledTaskByChatId: {
                        [chatId]: {
                            [scheduleTaskId]: {
                                tracking: { skipNext: false },
                            },
                        },
                    },
                },
            },
            effects: [
                { type: "schedule_timer_set", chatId, scheduleTaskId, rule: task.rule },
                {
                    type: "cold_append",
                    stream: "scheduled-tasks",
                    entry: { scheduleTaskId, chatId, event: "skipped", reason: "skipNext", fireIso },
                },
            ],
        }
    }

    const runIso = fireIso ?? new Date().toISOString()
    dbg("SCHED-FIRE", `firing ${scheduleTaskId} as run ${runIso}`)
    return {
        stateChanges: {
            specialData: {
                scheduledTaskByChatId: {
                    [chatId]: {
                        [scheduleTaskId]: {
                            state: "running",
                            currentRun: {
                                runIso,
                                startedAt: new Date().toISOString(),
                                attempt: 1,
                            },
                        },
                    },
                },
            },
        },
        effects: [
            {
                type: "scheduled_task_worker_spawn",
                chatId, scheduleTaskId, runIso,
            },
            {
                type: "cold_append",
                stream: "scheduled-tasks",
                entry: { scheduleTaskId, chatId, event: "run_started", runIso },
            },
        ],
    }
}
```

- [ ] **Step 3: Create the report-ready handler.**

Create `lib/event-handlers/scheduled-task-report-ready.js`:

```js
// lib/event-handlers/scheduled-task-report-ready.js
//
// Worker's watcher saw report.md appear. Hand off to the critic.

import { versionedImport } from "../version.js"
const { findScheduledTask } = await versionedImport("../scheduled-task-actions.js", import.meta)

export default function handle(event, core) {
    const { chatId, scheduleTaskId, runIso } = event
    const found = findScheduledTask(core.specialData, scheduleTaskId)
    if (!found) { return null }
    return {
        effects: [
            {
                type: "spawn_critic",
                scheduledRun: { scheduleTaskId, runIso, chatId },
                attempt: 1,
            },
        ],
    }
}
```

- [ ] **Step 4: Extract the critic body into `runCriticAgainstDir` and add a scheduled-run branch.**

The existing `spawnCriticSubprocess` in `lib/effects/critic-subprocess.js` is ~300 lines and contains three coupled concerns: (A) long-task state lookup + transient DoD write, (B) the generic dir-scoped spawn/poll/parse body, (C) the long-task-shaped `critic_verdict` enqueue. We need (B) for both long-task and scheduled-run paths. Extract it.

**4a.** At the bottom of `lib/effects/critic-subprocess.js`, add a dir-scoped helper. This is literally the existing body from `const start = Date.now()` down to the end of the IIFE, pulled out and parameterized on `dir`, `attempt`, `certPath`, `revPath`, `logPath`:

```js
/**
 * Run a critic claude -p against a directory that already contains
 * definition_of_done.md, context.md (optional), and report.md. Returns
 * a promise that resolves when the subprocess has either produced a
 * verdict or been killed by the timeout.
 *
 * Returns { verdict, details, elapsedMs } where verdict is one of
 * "certified" | "revisions" | "indecisive" | "error".
 *
 * Does NOT enqueue a critic_verdict event — the caller is responsible
 * for shaping and enqueueing that, since the long-task path wants a
 * `taskId` and the scheduled-run path wants a `scheduledRun` wrapper.
 */
export async function runCriticAgainstDir({ dir, attempt }) {
    const start = Date.now()
    const prompt = buildCriticPrompt(dir)
    const model = getCriticModel()
    const fallbackModel = getCriticFallbackModel()
    const args = [
        "-p", prompt,
        "--model", model,
        "--fallback-model", fallbackModel,
        "--no-session-persistence",
        "--add-dir", dir,
        "--max-budget-usd", "0.50",
        "--dangerously-skip-permissions",
    ]
    const cleanEnv = { ...Deno.env.toObject() }
    for (const key of Object.keys(cleanEnv)) {
        if (key.startsWith("CLAUDE_") || key.startsWith("MCP_")) {
            delete cleanEnv[key]
        }
    }
    const HARD_TIMEOUT_MS = 180_000
    const POLL_MS = 500
    const STDOUT_QUIET_MS = 3_000

    const certPath = join(dir, "certification.md")
    const revPath = join(dir, "requested_revisions.md")
    const logPath = join(dir, `critic_output.attempt${attempt}.log`)

    let verdict = "error"
    let details = ""
    let child = null
    const stdoutChunks = []
    const stderrChunks = []
    try {
        child = new Deno.Command("claude", {
            args,
            env: cleanEnv,
            clearEnv: true,
            stdout: "piped",
            stderr: "piped",
        }).spawn()

        const drainStdout = (async () => {
            try { for await (const chunk of child.stdout) { stdoutChunks.push(chunk) } }
            catch (e) { dbg("CRITIC-SUB", `drain stdout:`, e) }
        })()
        const drainStderr = (async () => {
            try { for await (const chunk of child.stderr) { stderrChunks.push(chunk) } }
            catch (e) { dbg("CRITIC-SUB", `drain stderr:`, e) }
        })()

        const begin = Date.now()
        let exited = false
        let lastStdoutBytes = 0
        let lastStdoutChangeAt = 0
        const stdoutBytes = () => stdoutChunks.reduce((s, c) => s + c.byteLength, 0)
        const statusPromise = child.status.then((s) => { exited = true; return s }).catch(() => { exited = true; return null })

        while (!exited) {
            if (Date.now() - begin > HARD_TIMEOUT_MS) { break }
            const n = stdoutBytes()
            if (n !== lastStdoutBytes) { lastStdoutBytes = n; lastStdoutChangeAt = Date.now() }
            if (n > 0 && lastStdoutChangeAt > 0 && Date.now() - lastStdoutChangeAt > STDOUT_QUIET_MS) { break }
            await Promise.race([statusPromise, new Promise((r) => setTimeout(r, POLL_MS))])
        }

        if (!exited) {
            try { child.kill("SIGKILL") } catch (e) { dbg("CRITIC-SUB", "SIGKILL:", e) }
            try { await statusPromise } catch (_) {}
        }
        await Promise.race([drainStdout, new Promise((r) => setTimeout(r, 500))])
        await Promise.race([drainStderr, new Promise((r) => setTimeout(r, 500))])

        const decoder = new TextDecoder()
        const stdoutText = stdoutChunks.map((c) => decoder.decode(c, { stream: false })).join("")
        const parsed = parseCriticStdout(stdoutText)

        if (parsed.verdict === "certified") {
            try { Deno.writeTextFileSync(certPath, parsed.body || "(no details)") } catch (e) { dbg("CRITIC-SUB", `write cert:`, e) }
            verdict = "certified"
        } else if (parsed.verdict === "revisions") {
            try { Deno.writeTextFileSync(revPath, parsed.body || "(no details)") } catch (e) { dbg("CRITIC-SUB", `write rev:`, e) }
            verdict = "revisions"
            details = parsed.body || ""
        } else {
            verdict = "indecisive"
            details = stdoutText ? `no Accepted:/Revisions: prefix. First 200: ${stdoutText.slice(0, 200)}` : "no stdout"
        }

        // Flush logs
        try {
            const stderrText = stderrChunks.map((c) => decoder.decode(c, { stream: false })).join("")
            Deno.writeTextFileSync(logPath, `=== stdout ===\n${stdoutText}\n=== stderr ===\n${stderrText}`)
        } catch (e) { dbg("CRITIC-SUB", "log flush:", e) }
    } catch (e) {
        verdict = "error"
        details = String(e)
        dbg("CRITIC-SUB", `critic threw:`, e)
    }
    return { verdict, details, elapsedMs: Date.now() - start }
}
```

**4b.** Replace the inline spawn body in the existing `spawnCriticSubprocess` function with a call to `runCriticAgainstDir`. Find the block starting with `const start = Date.now()` and ending at the `})()` that enqueues `critic_verdict`. Replace it with:

```js
    const { verdict, details, elapsedMs } = await runCriticAgainstDir({ dir, attempt })
    // Always clean up the transient definition file
    try { Deno.removeSync(defPath) } catch (e) { dbg("CRITIC-SUB", "cleanup def:", e) }
    core.enqueueEvent?.({
        type: "critic_verdict",
        taskId, chatId, sessionId,
        verdict, details, elapsedMs, attempt,
    })
```

**4c.** Add a scheduled-run branch at the top of `spawnCriticSubprocess`:

```js
export async function spawnCriticSubprocess(effect, core) {
    if (effect.scheduledRun) {
        return await spawnCriticForScheduledRun(effect, core)
    }
    const { taskId, dryRun = false, attempt = 1 } = effect
    // ... existing long-task logic unchanged, now using runCriticAgainstDir ...
```

**4d.** Add `spawnCriticForScheduledRun` at the bottom of the file:

```js
async function spawnCriticForScheduledRun(effect, core) {
    const { scheduledRun, attempt = 1 } = effect
    const { scheduleTaskId, runIso, chatId } = scheduledRun
    const runDir = paths.scheduledTaskRunDir(scheduleTaskId, runIso)
    const taskDir = paths.scheduledTaskDir(scheduleTaskId)

    // Copy the locked DoD into the run dir so runCriticAgainstDir's
    // buildCriticPrompt finds it via the usual definition_of_done.md
    // path. (buildCriticPrompt reads definition_of_done.md from `dir`.)
    try {
        const text = Deno.readTextFileSync(join(taskDir, "definition_of_done.md"))
        Deno.writeTextFileSync(join(runDir, "definition_of_done.md"), text)
    } catch (e) {
        dbg("CRITIC-SUB", `copy DoD for scheduled run failed:`, e)
        core.enqueueEvent?.({
            type: "critic_verdict",
            scheduledRun,
            verdict: "error",
            details: `failed to read DoD: ${e}`,
            elapsedMs: 0,
            attempt,
        })
        return
    }

    const { verdict, details, elapsedMs } = await runCriticAgainstDir({ dir: runDir, attempt })
    core.enqueueEvent?.({
        type: "critic_verdict",
        scheduledRun,
        verdict, details, elapsedMs, attempt,
    })
}
```

- [ ] **Step 5: Extend critic-verdict.js to branch on `scheduledRun`.**

In `lib/event-handlers/critic-verdict.js`, at the top of the handler:

```js
export default function handle(event, core) {
    if (event.scheduledRun) {
        return handleScheduledRunVerdict(event, core)
    }
    // ... existing long-task logic unchanged ...
```

Add `handleScheduledRunVerdict` below:

```js
function handleScheduledRunVerdict(event, core) {
    const { scheduledRun, verdict, details, attempt = 1 } = event
    const { scheduleTaskId, runIso, chatId } = scheduledRun
    const found = findScheduledTask(core.specialData, scheduleTaskId)
    if (!found) { return null }

    if (verdict === "certified") {
        // Read the worker's report body so we can include it in the
        // user-facing certified message downstream.
        const reportPath = `${paths.scheduledTaskRunDir(scheduleTaskId, runIso)}/report.md`
        let body = ""
        try { body = Deno.readTextFileSync(reportPath) } catch (e) { dbg("CRITIC-VERDICT", "read report.md:", e) }
        return {
            effects: [
                { type: "scheduled_task_worker_kill", scheduleTaskId, runIso },
                {
                    type: "cold_append",
                    stream: "scheduled-tasks",
                    entry: { scheduleTaskId, chatId, event: "run_certified", runIso },
                },
            ],
            followUpEvents: [
                {
                    type: "scheduled_task_run_complete",
                    chatId, scheduleTaskId, runIso,
                    status: "certified",
                    summary: body.slice(0, 2000),
                },
            ],
        }
    }

    if (verdict === "revisions") {
        const revText = details || "(no details)"
        const revPath = `${paths.scheduledTaskRunDir(scheduleTaskId, runIso)}/revision_request.md`
        return {
            effects: [
                { type: "write_file", path: revPath, content: revText },
                { type: "delete_file", path: `${paths.scheduledTaskRunDir(scheduleTaskId, runIso)}/report.md` },
                {
                    type: "scheduled_task_worker_inject",
                    scheduleTaskId, runIso,
                    text: `Revisions requested — read ./runs/${runIso}/revision_request.md, update ./runs/${runIso}/report.md, and continue.`,
                },
                // The worker's existing watcher (still running from the spawn
                // effect) will detect the next report.md appearance and
                // re-emit scheduled_task_worker_report_ready.
            ],
        }
    }

    // indecisive / error / anomaly → retry up to N
    const maxRetries = 3
    if (attempt < maxRetries && (verdict === "indecisive" || verdict === "error")) {
        return {
            effects: [
                {
                    type: "spawn_critic",
                    scheduledRun,
                    attempt: attempt + 1,
                },
            ],
        }
    }

    // Give up.
    return {
        effects: [
            { type: "scheduled_task_worker_kill", scheduleTaskId, runIso },
            {
                type: "cold_append",
                stream: "scheduled-tasks",
                entry: { scheduleTaskId, chatId, event: "run_errored", runIso, verdict, details },
            },
        ],
        followUpEvents: [
            {
                type: "scheduled_task_run_complete",
                chatId, scheduleTaskId, runIso,
                status: "errored",
                summary: `critic gave up after ${attempt} attempts: ${details?.slice(0, 500) ?? verdict}`,
            },
        ],
    }
}
```

Add the imports at the top of `critic-verdict.js`:

```js
const { findScheduledTask } = await versionedImport("../scheduled-task-actions.js", import.meta)
```

**Watch for import collision:** critic-verdict.js already imports `paths`; reuse that. Don't double-import.

**Bug cleanup:** the scaffolded `handleScheduledRunVerdict` has an `effects` array that contains an incomplete `{ type: "scheduled_task_run_complete" }` fragment. Delete it. The `followUpEvents` entry is the real path.

- [ ] **Step 6: Commit.**

```bash
git add lib/effects/scheduled-task-worker.js lib/event-handlers/scheduled-task-fire.js lib/event-handlers/scheduled-task-report-ready.js lib/effects/critic-subprocess.js lib/event-handlers/critic-verdict.js
git commit -m "scheduled-tasks: fire + report-ready handlers, critic branches for scheduled runs"
```

---

## Task 11: scheduled-task-run-complete handler + rearm

**Files:**
- Create: `lib/event-handlers/scheduled-task-run-complete.js`

- [ ] **Step 1: Implement the handler.**

Create `lib/event-handlers/scheduled-task-run-complete.js`:

```js
// lib/event-handlers/scheduled-task-run-complete.js
//
// Finalize a run: update tracking, rearm the next fire, notify the user.

import { versionedImport } from "../version.js"
const { dbg } = await versionedImport("../logging.js", import.meta)
const { findScheduledTask, scheduleCommandLinks } = await versionedImport("../scheduled-task-actions.js", import.meta)
const { escapeHtml: esc } = await versionedImport("../pure/html.js", import.meta)

const RUN_HISTORY_MAX = 10

export default function handle(event, core) {
    const { chatId, scheduleTaskId, runIso, status, summary } = event
    const found = findScheduledTask(core.specialData, scheduleTaskId)
    if (!found) { return null }
    const { task } = found

    const prevHistory = task.tracking?.runHistory ?? []
    const newEntry = { runIso, status, summary: (summary ?? "").slice(0, 300), at: new Date().toISOString() }
    const nextHistory = [...prevHistory, newEntry].slice(-RUN_HISTORY_MAX)
    const totalRuns = (task.tracking?.totalRuns ?? 0) + 1

    const nextState = task.state === "cancelled" ? "cancelled" : "scheduled"

    const summaryText = status === "certified"
        ? `✅ Scheduled task <code>${esc(scheduleTaskId)}</code> run certified.\n\n<pre>${esc((summary ?? "").slice(0, 1500))}</pre>\n\n${scheduleCommandLinks(scheduleTaskId)}`
        : `⚠️ Scheduled task <code>${esc(scheduleTaskId)}</code> run errored.\n\n${esc((summary ?? "").slice(0, 500))}\n\n${scheduleCommandLinks(scheduleTaskId)}`

    const effects = [
        {
            type: "send_text_to_user",
            chatId,
            text: summaryText,
            options: { parse_mode: "HTML" },
        },
        {
            type: "cold_append",
            stream: "scheduled-tasks",
            entry: { scheduleTaskId, chatId, event: "run_complete", runIso, status },
        },
    ]

    // Rearm timer unless cancelled.
    if (nextState !== "cancelled") {
        effects.push({
            type: "schedule_timer_set",
            chatId, scheduleTaskId, rule: task.rule,
        })
    }

    dbg("SCHED-DONE", `${scheduleTaskId} run ${runIso} → ${status}`)
    return {
        stateChanges: {
            specialData: {
                scheduledTaskByChatId: {
                    [chatId]: {
                        [scheduleTaskId]: {
                            state: nextState,
                            currentRun: undefined,
                            tracking: {
                                totalRuns,
                                lastRunAt: new Date().toISOString(),
                                lastRunStatus: status,
                                lastRunSummary: (summary ?? "").slice(0, 300),
                                runHistory: nextHistory,
                            },
                        },
                    },
                },
            },
        },
        effects,
    }
}
```

- [ ] **Step 2: Commit.**

```bash
git add lib/event-handlers/scheduled-task-run-complete.js
git commit -m "handlers: scheduled-task-run-complete (tracking + rearm + notify)"
```

---

## Task 12: Register new handlers + effects in main-event-processor

**Files:**
- Modify: `lib/main-event-processor.js`

- [ ] **Step 1: Import the new effect modules at the top.**

In the `await Promise.all([...])` block near the top of `lib/main-event-processor.js`, add two more entries:

```js
    const [
        telegramOutbound,
        // ... existing imports ...
        telegramDownload,
        scheduleTimer,
        scheduledTaskWorker,
    ] = await Promise.all([
        // ... existing ...
        versionedImport("./effects/telegram-download.js", import.meta),
        versionedImport("./effects/schedule-timer.js", import.meta),
        versionedImport("./effects/scheduled-task-worker.js", import.meta),
    ])
```

- [ ] **Step 2: Register the new effect types in `effectDispatch`.**

Add to the `effectDispatch` table:

```js
    // Scheduled tasks
    "schedule_timer_set":             scheduleTimer.scheduleTimerSet,
    "schedule_timer_clear":           scheduleTimer.scheduleTimerClear,
    "scheduled_task_worker_spawn":    scheduledTaskWorker.spawnScheduledTaskWorker,
    "scheduled_task_worker_inject":   scheduledTaskWorker.injectScheduledTaskText,
    "scheduled_task_worker_kill":     scheduledTaskWorker.killScheduledTaskWorker,
```

- [ ] **Step 3: Register the new handlers in the `handlers` table.**

Add to `handlers`:

```js
    "scheduled_task_definition_submitted": (await versionedImport("./event-handlers/scheduled-task-definition-submitted.js", import.meta)).default,
    "scheduled_task_fire": (await versionedImport("./event-handlers/scheduled-task-fire.js", import.meta)).default,
    "scheduled_task_worker_report_ready": (await versionedImport("./event-handlers/scheduled-task-report-ready.js", import.meta)).default,
    "scheduled_task_run_complete": (await versionedImport("./event-handlers/scheduled-task-run-complete.js", import.meta)).default,
```

- [ ] **Step 4: Deno-check.**

```bash
cd /Users/jeffhykin/repos/cbg1 && deno check lib/main-event-processor.js
```

Expected: no errors.

- [ ] **Step 5: Commit.**

```bash
git add lib/main-event-processor.js
git commit -m "event-loop: register schedule effects + handlers"
```

---

## Task 13: /schedule chat command + dynamic regex commands

**Files:**
- Modify: `lib/event-handlers/chat-user.js`

- [ ] **Step 1: Add the imports near the top.**

After the existing `buildCancelAction, taskCommandLinks` import, add:

```js
const { buildScheduleCancelAction, scheduleCommandLinks, findScheduledTask } = await versionedImport("../scheduled-task-actions.js", import.meta)
```

- [ ] **Step 2: Add dynamic `/schedule_*_<id>` regex handlers.**

In the section of chat-user.js where `/task_status_`, `/task_view_`, etc. are matched, add:

```js
    const scheduleStatusMatch = /^\/schedule_status_(\w+)/i.exec(trimmed)
    if (scheduleStatusMatch) {
        return wrap(handleScheduleStatus(event, core, scheduleStatusMatch[1]))
    }
    const scheduleViewMatch = /^\/schedule_view_(\w+)/i.exec(trimmed)
    if (scheduleViewMatch) {
        return wrap(handleScheduleView(event, core, scheduleViewMatch[1]))
    }
    const scheduleCancelMatch = /^\/schedule_cancel_(\w+)/i.exec(trimmed)
    if (scheduleCancelMatch) {
        return wrap(buildScheduleCancelAction(core, event.chatId, scheduleCancelMatch[1]))
    }
    const schedulePauseMatch = /^\/schedule_pause_(\w+)/i.exec(trimmed)
    if (schedulePauseMatch) {
        return wrap(handleSchedulePause(event, core, schedulePauseMatch[1]))
    }
    // /schedule <free-form description> — create a new scheduled task.
    // Must come AFTER the /schedule_* matchers.
    const scheduleNewMatch = /^\/schedule\s+(.+)/i.exec(trimmed)
    if (scheduleNewMatch) {
        return wrap(handleScheduleCreate(event, core, scheduleNewMatch[1].trim()))
    }
```

- [ ] **Step 3: Add the handler functions.**

Add at the bottom of chat-user.js (or near `handleTaskCreate`):

```js
function generateUniqueScheduleId(core) {
    const existing = new Set()
    const byChat = core.specialData?.scheduledTaskByChatId ?? {}
    for (const tasks of Object.values(byChat)) {
        for (const id of Object.keys(tasks ?? {})) { existing.add(id) }
    }
    let id
    do { id = `sch_${randomHex(3)}` } while (existing.has(id))
    return id
}

function handleScheduleCreate(event, core, description) {
    const { chatId } = event
    if (!description) {
        return reply(chatId, "Usage: <code>/schedule &lt;description&gt;</code>")
    }
    const focusedId = core.chatState?.focusedSessionId
    if (!focusedId) {
        return reply(chatId, "No focused session. Use /new to create one first.")
    }

    const scheduleTaskId = generateUniqueScheduleId(core)
    const title = description.split(/\s+/).slice(0, 6).join(" ")
    const createdAt = new Date().toISOString()
    const newTask = {
        id: scheduleTaskId,
        title,
        originalPrompt: description,
        createdAt,
        state: "defining",
        draftingSessionId: focusedId,
        definitionOfDone: null,
        rule: null,
        tracking: {
            totalRuns: 0,
            lastRunAt: null,
            lastRunStatus: null,
            nextFireAt: null,
            skipNext: false,
            runHistory: [],
        },
        currentRun: null,
    }
    const taskDirAbs = paths.scheduledTaskDir(scheduleTaskId)

    const prompt = [
        `The user would like to schedule a recurring task (id: ${scheduleTaskId}).`,
        ``,
        `User's request:`,
        `> ${description}`,
        ``,
        `Your job in this phase:`,
        `1. Clarify the RECURRENCE RULE with the user. Produce an rrule.js JSON object with these fields:`,
        `   freq (required): YEARLY|MONTHLY|WEEKLY|DAILY|HOURLY|MINUTELY`,
        `   interval, byhour, byminute, byday ("MO","TU",…), bymonth, bymonthday, count, until, tzid`,
        `   Time-of-day handling rules (MUST follow these before submitting):`,
        `   - If config schedule.default_tz is set, use it silently.`,
        `   - If the rule has no meaningful time-of-day (e.g. a monthly/yearly`,
        `     rule with no explicit hour), default tzid to the system's current`,
        `     timezone (Intl.DateTimeFormat().resolvedOptions().timeZone) and`,
        `     mention it in your confirmation.`,
        `   - If the user's wording carries context (\"in the morning\", \"before`,
        `     my meeting\", \"after work\"), pick a time and tz and ECHO the`,
        `     inference explicitly in your confirmation.`,
        `   - Otherwise ASK EXPLICITLY: \"absolute tzid or your current timezone?\"`,
        `   - Sunrise/sunset and \"follow me while traveling\" are NOT supported.`,
        ``,
        `2. Write a DEFINITION OF DONE that is concrete and falsifiable. The DoD`,
        `   MUST name the exact path the worker writes its output to each run`,
        `   (typically \`runs/<runIso>/report.md\` under the task dir).`,
        ``,
        `3. Call the MCP tool \`submit_scheduled_task_definition\` with:`,
        `     { scheduleTaskId: \"${scheduleTaskId}\", rule: {...}, definitionOfDone: \"...\", title: \"...\" }`,
        ``,
        `Task directory: ${taskDirAbs}`,
        ``,
        `<user_prompt>`,
        description,
        `</user_prompt>`,
    ].join("\n")

    dbg("CHAT-USER", `creating scheduled task ${scheduleTaskId} for session ${focusedId}`)

    return {
        stateChanges: {
            specialData: {
                scheduledTaskByChatId: {
                    [chatId]: { [scheduleTaskId]: newTask },
                },
            },
        },
        effects: [
            { type: "mkdir", path: taskDirAbs },
            {
                type: "deliver_channel_event",
                sessionId: focusedId,
                content: prompt,
                meta: {},
            },
            {
                type: "send_text_to_user",
                chatId,
                text: `Drafting scheduled task <code>${esc(scheduleTaskId)}</code> — clarify with the agent, then it'll be locked.`,
                options: { parse_mode: "HTML" },
            },
        ],
    }
}

function handleScheduleStatus(event, core, scheduleTaskId) {
    const found = findScheduledTask(core.specialData, scheduleTaskId)
    if (!found) {
        return reply(event.chatId, `Unknown scheduled task: <code>${esc(scheduleTaskId)}</code>`)
    }
    const t = found.task
    const lines = [
        `<b>Scheduled task <code>${esc(scheduleTaskId)}</code></b>`,
        `State: <code>${esc(t.state)}</code>`,
        `Next fire: <code>${esc(t.tracking?.nextFireAt ?? "(unknown)")}</code>`,
        `Last run: <code>${esc(t.tracking?.lastRunAt ?? "(never)")}</code> — ${esc(t.tracking?.lastRunStatus ?? "(none)")}`,
        `Total runs: <code>${esc(String(t.tracking?.totalRuns ?? 0))}</code>`,
        `Skip next: <code>${esc(String(t.tracking?.skipNext ?? false))}</code>`,
        ``,
        scheduleCommandLinks(scheduleTaskId),
    ]
    return reply(event.chatId, lines.join("\n"))
}

function handleScheduleView(event, core, scheduleTaskId) {
    const found = findScheduledTask(core.specialData, scheduleTaskId)
    if (!found) {
        return reply(event.chatId, `Unknown scheduled task: <code>${esc(scheduleTaskId)}</code>`)
    }
    const t = found.task
    const lines = [
        `<b>Scheduled task <code>${esc(scheduleTaskId)}</code></b>`,
        `Title: ${esc(t.title ?? "")}`,
        ``,
        `<b>Rule</b>`,
        `<pre>${esc(JSON.stringify(t.rule ?? {}, null, 2))}</pre>`,
        ``,
        `<b>Definition of done</b>`,
        `<pre>${esc((t.definitionOfDone ?? "(none)").slice(0, 2000))}</pre>`,
        ``,
        `<b>Recent runs</b>`,
        ...((t.tracking?.runHistory ?? []).slice(-5).map((r) =>
            `- ${esc(r.at ?? "?")}: <code>${esc(r.status)}</code> ${esc((r.summary ?? "").slice(0, 100))}`
        )),
        ``,
        scheduleCommandLinks(scheduleTaskId),
    ]
    return reply(event.chatId, lines.join("\n"))
}

function handleSchedulePause(event, core, scheduleTaskId) {
    const found = findScheduledTask(core.specialData, scheduleTaskId)
    if (!found) {
        return reply(event.chatId, `Unknown scheduled task: <code>${esc(scheduleTaskId)}</code>`)
    }
    const prev = found.task.tracking?.skipNext ?? false
    const next = !prev
    return {
        stateChanges: {
            specialData: {
                scheduledTaskByChatId: {
                    [found.chatId]: {
                        [scheduleTaskId]: {
                            tracking: { skipNext: next },
                        },
                    },
                },
            },
        },
        effects: [
            {
                type: "send_text_to_user",
                chatId: event.chatId,
                text: `Scheduled task <code>${esc(scheduleTaskId)}</code>: skipNext=${next ? "<b>true</b>" : "false"}`,
                options: { parse_mode: "HTML" },
            },
        ],
    }
}
```

- [ ] **Step 3.5: Add /schedule to help.**

Check `commands/help.js` — if it enumerates slash commands, add `/schedule`.

- [ ] **Step 4: Run all tests to confirm nothing existing broke.**

```bash
cd /Users/jeffhykin/repos/cbg1 && deno test tests/ --allow-all 2>&1 | tail -20
```

Expected: all previously-passing tests still pass, plus the schedule tests from Task 8.

- [ ] **Step 5: Commit.**

```bash
git add lib/event-handlers/chat-user.js commands/help.js
git commit -m "chat-user: /schedule create + /schedule_* dynamic commands"
```

---

## Task 14: Startup rehydration of timers

**Files:**
- Modify: `main-server.js`

- [ ] **Step 1: Read the existing startup code.**

Find the section after `loadPersistedState()` and where the main event loop starts. We need to iterate `specialData.scheduledTaskByChatId` and emit `schedule_timer_set` via a synthetic effect dispatch — or just call the effect module directly.

- [ ] **Step 2: Add a rehydrateScheduledTimers call.**

Somewhere after state load and before the main event loop starts:

```js
// Rehydrate in-process schedule timers. We do this by enqueuing
// schedule_timer_set effects through a synthetic "startup" event
// that has no handler — but since effects run per-handler, the
// cleanest path is to enqueue `scheduled_task_fire` events... no,
// wait — use a one-off rehydrate handler.
{
    const { paths: _paths } = await versionedImport("./lib/paths.js", import.meta)
    const byChat = core.specialData?.scheduledTaskByChatId ?? {}
    const orphans = []
    for (const [chatId, tasks] of Object.entries(byChat)) {
        for (const [taskId, task] of Object.entries(tasks ?? {})) {
            if (task.state === "cancelled" || task.state === "completed" || task.state === "errored") { continue }
            // Orphan detection: if currentRun is set, we were mid-run
            // when the daemon died. Mark that run errored and fall
            // through to rearm the next fire.
            if (task.currentRun) {
                orphans.push({ chatId, scheduleTaskId: taskId, runIso: task.currentRun.runIso })
            }
            core.enqueueEvent({
                type: "scheduled_task_rehydrate",
                chatId,
                scheduleTaskId: taskId,
                rule: task.rule,
            })
        }
    }
    // For each orphan, enqueue a synthetic run-complete to clean up.
    for (const o of orphans) {
        core.enqueueEvent({
            type: "scheduled_task_run_complete",
            chatId: o.chatId,
            scheduleTaskId: o.scheduleTaskId,
            runIso: o.runIso,
            status: "errored",
            summary: "daemon restarted mid-run; orphaned run cleaned up",
        })
    }
}
```

- [ ] **Step 3: Create the rehydrate handler.**

Create `lib/event-handlers/scheduled-task-rehydrate.js`:

```js
// lib/event-handlers/scheduled-task-rehydrate.js
//
// One-shot event emitted by main-server at startup for each
// non-terminal scheduled task. Just emits a schedule_timer_set.

export default function handle(event, _core) {
    const { chatId, scheduleTaskId, rule } = event
    if (!chatId || !scheduleTaskId || !rule) { return null }
    return {
        effects: [
            { type: "schedule_timer_set", chatId, scheduleTaskId, rule },
        ],
    }
}
```

Register it in `lib/main-event-processor.js`'s `handlers` table:

```js
    "scheduled_task_rehydrate": (await versionedImport("./event-handlers/scheduled-task-rehydrate.js", import.meta)).default,
```

- [ ] **Step 4: Commit.**

```bash
git add main-server.js lib/event-handlers/scheduled-task-rehydrate.js lib/main-event-processor.js
git commit -m "main-server: rehydrate scheduled-task timers on startup + orphan cleanup"
```

---

## Task 15: Extend /cron to include CBG scheduled tasks

**Files:**
- Modify: `commands/cron.js`

- [ ] **Step 1: Add a section that reads specialData.scheduledTaskByChatId.**

In `commands/cron.js`, after the existing "Scheduled Tasks" rendering (from `~/.claude/scheduled-tasks/`), add:

```js
        // CBG-managed scheduled tasks
        const byChat = _core?.specialData?.scheduledTaskByChatId ?? {}
        const cbgTasks = []
        for (const [chatId, tasks] of Object.entries(byChat)) {
            for (const [id, task] of Object.entries(tasks ?? {})) {
                cbgTasks.push({ chatId, id, task })
            }
        }
        if (cbgTasks.length > 0) {
            parts.push("")
            parts.push(`<b>CBG Scheduled Tasks</b> (${cbgTasks.length})`)
            parts.push("")
            for (const { id, task } of cbgTasks) {
                parts.push(`⏰ <code>${esc(id)}</code> — ${esc(task.title ?? "")}`)
                parts.push(`   state=${esc(task.state)} next=${esc(task.tracking?.nextFireAt ?? "?")}`)
                parts.push(`   /schedule_status_${esc(id)}   /schedule_cancel_${esc(id)}`)
            }
        }
```

Change the command signature to `cron: (event, _core) => { ... }` (it probably already is — just ensure `_core` is in scope).

- [ ] **Step 2: Commit.**

```bash
git add commands/cron.js
git commit -m "cron: render CBG-managed scheduled tasks alongside skill-based ones"
```

---

## Task 16: Run full test suite + manual smoke test

- [ ] **Step 1: Run the full test suite.**

```bash
cd /Users/jeffhykin/repos/cbg1 && deno test tests/ --allow-all 2>&1 | tail -30
```

Expected: all tests pass. If any handler test for long-task broke due to critic-subprocess refactor, fix it before proceeding.

- [ ] **Step 2: Start the daemon and run an end-to-end smoke test.**

In a shell:

```bash
cd /Users/jeffhykin/repos/cbg1 && cbg restart && tail -f ~/.local/share/cbg/state/main.log &
```

In Telegram:

1. `/new` — get a fresh interactive session.
2. `/schedule every minute for 3 fires, write "hello <N>" to runs/<iso>/report.md` — the drafting worker should clarify / produce a rule / call `submit_scheduled_task_definition`.
3. Wait ~1 minute. Expect: a run kicks off, critic certifies, you get a Telegram message with the report body.
4. Wait another minute. Expect: second run.
5. `/schedule_cancel_<id>` — confirms cancel.
6. `/cron` — shows the cancelled task in history.

- [ ] **Step 3: Document any issues found in a follow-up bug task list or fix inline.**

- [ ] **Step 4: Commit any smoke-test-driven fixes + push the branch.**

```bash
git push -u origin schedule-feature
```

---

## Self-review checklist (fill after writing)

- [ ] Every spec requirement has a task.
- [ ] No placeholder text ("TBD", "TODO", "implement appropriate…").
- [ ] Type/field names are consistent between tasks.
- [ ] The new `specialData.scheduledTaskByChatId` shape matches the spec's data section exactly.
- [ ] `/schedule_pause` + `skipNext` wiring lines up with the fire handler's skip logic.
- [ ] Missed-fire policy is observed (on boot we just rearm next; no catch-up).
- [ ] `--no-tele` is used when spawning the worker.
- [ ] Worker cwd = task dir (not run dir).
- [ ] Drafting prompt includes all four TZ clarification rules.
- [ ] No `deliver_channel_event` used for worker comms in spawn or critic-revisions paths.
- [ ] Critic runs against per-run subdir with copied DoD.
- [ ] `schedule_timer_set` is emitted after every completed or skipped fire.
