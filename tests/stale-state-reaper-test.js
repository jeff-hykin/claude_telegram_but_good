// tests/stale-state-reaper-test.js — the hourly session/task reaper's decisions.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths } from "./_helpers.js"

setupTempPaths("cbg-reaper-test-")

const { default: handle } = await import("../lib/event-handlers/stale-state-reaper.js")

const DAY = 24 * 60 * 60 * 1000
const ago = (days) => Date.now() - days * DAY

Deno.test("reaper: drops long-dead sessions and old terminal tasks, cancels orphaned ones", () => {
    const core = {
        chatState: {},
        chatSessions: {
            deadOld: { id: "deadOld", lastActive: ago(30) },
            deadRecent: { id: "deadRecent", lastActive: ago(2) },
            liveOld: { id: "liveOld", lastActive: ago(30), _conn: {} },
        },
        specialData: {
            longTaskByChatId: {
                "1": {
                    oldCancelled: { state: "cancelled", createdAt: new Date(ago(60)).toISOString(), cancelledAt: new Date(ago(20)).toISOString() },
                    newCancelled: { state: "cancelled", createdAt: new Date(ago(60)).toISOString(), cancelledAt: new Date(ago(3)).toISOString() },
                    orphan: { state: "in_progress", createdAt: new Date(ago(40)).toISOString(), lastCheckinAt: ago(20), workerSessionId: "deadOld" },
                    working: { state: "in_progress", createdAt: new Date(ago(40)).toISOString(), lastCheckinAt: ago(20), workerSessionId: "liveOld" },
                },
            },
        },
    }
    const action = handle({ type: "stale_state_reaper" }, core)
    assertEquals(Object.keys(action.stateChanges.chatSessions), ["deadOld"])
    const tasks = action.stateChanges.specialData.longTaskByChatId["1"]
    assert("oldCancelled" in tasks && tasks.oldCancelled === undefined)
    assertEquals(tasks.orphan.state, "cancelled")
    assertEquals(tasks.orphan.stateBeforeCancel, "in_progress")
    assert(!("newCancelled" in tasks) && !("working" in tasks))
    const files = action.effects.find(e => e.type === "reap_stale_files")
    assertEquals(files.keptSessionIds.sort(), ["deadRecent", "liveOld"])
    assert(!files.keptTaskIds.includes("oldCancelled"))
})

Deno.test("reaper: the startup tick only arms the timer", () => {
    const action = handle({ type: "stale_state_reaper", startup: true }, { chatSessions: { x: { lastActive: 0 } } })
    assertEquals(action.effects.map(e => e.type), ["set_timer"])
    assertEquals(action.stateChanges, undefined)
})
