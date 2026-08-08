// tests/handler-task-checkin-test.js
//
// Regression tests for task-checkin. The load-bearing property: while a
// task is in_progress the check-in watchdog must NEVER die — every fire
// that clears the rate-limit gate reschedules itself, regardless of
// report.md. A previous version returned null (no reschedule) as soon as
// report.md existed, so a worker that wrote report.md then went idle
// mid-turn (critic never spawned on a Stop) left the task wedged with no
// watchdog — it stalled ~4h unseen.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, makeCore, effectsOfType, paths } from "./_helpers.js"

setupTempPaths("cbg-task-checkin-test-")

const checkin = (await import("../lib/event-handlers/task-checkin.js")).default

const CHAT = "42"
const TASK = "t1"
const SESSION = "worker"

function writeReport() {
    Deno.mkdirSync(paths.longTaskDir(TASK), { recursive: true })
    Deno.writeTextFileSync(paths.longTaskDir(TASK) + "/report.md", "# done")
}
function removeReport() {
    try { Deno.removeSync(paths.longTaskDir(TASK) + "/report.md") } catch { /* ignore */ }
}

function coreFor(taskOverrides = {}, { activeCritics = [] } = {}) {
    const core = makeCore({
        chatSessions: { [SESSION]: { longTaskId: TASK, pendingNudgeAction: "taskCheck" } },
        specialData: {
            longTaskByChatId: {
                [CHAT]: {
                    [TASK]: { id: TASK, state: "in_progress", workerSessionId: SESSION, ...taskOverrides },
                },
            },
        },
    })
    core.activeCritics = new Set(activeCritics)
    return core
}

const ev = (ts) => ({ type: "task_checkin", sessionId: SESSION, taskId: TASK, ts })

function reschedules(action) {
    return effectsOfType(action, "set_timer").some(e => e.event?.type === "task_checkin")
}
function nudgeTexts(action) {
    return effectsOfType(action, "send_text_to_claude").map(e => e.text)
}

Deno.test("checkin: no report.md → nudges to report AND reschedules", () => {
    removeReport()
    const action = checkin(ev(1_000_000), coreFor())
    assert(reschedules(action), "must reschedule the check-in timer")
    assertEquals(nudgeTexts(action).length, 1)
    assert(nudgeTexts(action)[0].includes("check-in"))
})

Deno.test("checkin: nudge includes the chat_id so the worker doesn't hunt for it", () => {
    removeReport()
    const action = checkin(ev(1_000_000), coreFor())
    assert(nudgeTexts(action)[0].includes(CHAT), "check-in nudge must include the chat_id")
    writeReport()
    const stalled = checkin(ev(2_000_000), coreFor())
    assert(nudgeTexts(stalled)[0].includes(CHAT), "report-stalled nudge must include the chat_id")
})

Deno.test("checkin: report.md exists, no critic → prompts end-of-turn, re-arms taskCheck, STILL reschedules", () => {
    writeReport()
    const action = checkin(ev(1_000_000), coreFor())
    assert(reschedules(action), "watchdog must stay alive even when report.md exists")
    assertEquals(nudgeTexts(action).length, 1)
    assert(nudgeTexts(action)[0].includes("reviewer"))
    assertEquals(action.stateChanges.chatSessions[SESSION].pendingNudgeAction, "taskCheck")
})

Deno.test("checkin: report.md exists, critic in flight → no nudge but STILL reschedules", () => {
    writeReport()
    const action = checkin(ev(1_000_000), coreFor({}, { activeCritics: [TASK] }))
    assert(reschedules(action), "watchdog must stay alive while critic runs")
    assertEquals(nudgeTexts(action).length, 0)
})

Deno.test("checkin: always bumps lastCheckinAt when it fires", () => {
    removeReport()
    const now = 5_000_000
    const action = checkin(ev(now), coreFor())
    assertEquals(action.stateChanges.specialData.longTaskByChatId[CHAT][TASK].lastCheckinAt, now)
})

Deno.test("checkin: rate-limited (<20m since last) → suppressed, no reschedule (drains stacked timers)", () => {
    removeReport()
    const now = 5_000_000
    const action = checkin(ev(now), coreFor({ lastCheckinAt: now - 5 * 60 * 1000 }))
    assertEquals(action, null)
})

Deno.test("checkin: >20m since last → fires and reschedules", () => {
    removeReport()
    const now = 5_000_000
    const action = checkin(ev(now), coreFor({ lastCheckinAt: now - 25 * 60 * 1000 }))
    assert(reschedules(action))
})

Deno.test("checkin: task not in_progress → dies (no reschedule)", () => {
    removeReport()
    const action = checkin(ev(1_000_000), coreFor({ state: "escalated" }))
    assertEquals(action, null)
})

// An in_progress task whose worker vanished is the case that most needs a
// watchdog, so losing the worker must not be what silences it.

Deno.test("checkin: a vanished worker keeps the watchdog alive", () => {
    removeReport()
    const core = coreFor()
    delete core.chatSessions[SESSION]
    const action = checkin(ev(1_000_000), core)
    assert(reschedules(action))
    assertEquals(action.stateChanges.specialData.longTaskByChatId[CHAT][TASK].orphanedSince, 1_000_000)
})

Deno.test("checkin: a worker that moved on also counts as orphaned", () => {
    removeReport()
    const core = coreFor()
    core.chatSessions[SESSION].longTaskId = "other"
    assert(reschedules(checkin(ev(1_000_000), core)))
})

Deno.test("checkin: an orphaned task stays quiet at first, then tells the user once", () => {
    removeReport()
    const orphanedSince = 1_000_000
    const core = coreFor({ orphanedSince })
    delete core.chatSessions[SESSION]

    const early = checkin(ev(orphanedSince + 5 * 60 * 1000), core)
    assertEquals(effectsOfType(early, "send_text_to_user").length, 0)

    const late = checkin(ev(orphanedSince + 45 * 60 * 1000), core)
    const alerts = effectsOfType(late, "send_text_to_user")
    assertEquals(alerts.length, 1)
    assertEquals(alerts[0].chatId, CHAT)
    assert(alerts[0].text.includes(TASK))

    const alerted = coreFor({ orphanedSince, orphanAlertedAt: orphanedSince + 45 * 60 * 1000 })
    delete alerted.chatSessions[SESSION]
    assertEquals(effectsOfType(checkin(ev(orphanedSince + 90 * 60 * 1000), alerted), "send_text_to_user").length, 0)
})

Deno.test("checkin: a worker that comes back clears the orphan markers", () => {
    removeReport()
    const core = coreFor({ orphanedSince: 1_000, orphanAlertedAt: 2_000 })
    const patch = checkin(ev(5_000_000), core).stateChanges.specialData.longTaskByChatId[CHAT][TASK]
    assertEquals(patch.orphanedSince, undefined)
    assertEquals(patch.orphanAlertedAt, undefined)
    assert("orphanedSince" in patch)
})
