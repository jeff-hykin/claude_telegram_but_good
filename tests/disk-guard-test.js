import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, makeCore, fakeConn, effectsOfType } from "./_helpers.js"

setupTempPaths("cbg-disk-guard-test-")
const { default: diskGuard, handleTick } = await import("../lib/event-handlers/disk-guard-check.js")

function lowCore(diskGuardLowSince) {
    return makeCore({
        chatState: { commandCenter: { chatId: "-100222" }, diskGuardLowSince },
        chatSessions: {
            A: { id: "A", _conn: fakeConn(), status: "working" },
            B: { id: "B", _conn: fakeConn(), status: "idle", lastStopAt: 1000, lastToolAt: 2000 },
            Idle: { id: "Idle", _conn: fakeConn(), status: "idle", lastStopAt: 2000, lastToolAt: 1000 },
            Fresh: { id: "Fresh", _conn: fakeConn() },
            Gone: { id: "Gone", status: "working" },
        },
    })
}

Deno.test("under the limit, every mid-turn session is warned on every tick (idle ones are never woken) and Jeff once", async () => {
    const first = await diskGuard({ type: "disk_guard_check", freeGb: 10, path: "/data" }, lowCore(undefined))
    assertEquals(effectsOfType(first, "deliver_channel_event").map((e) => e.sessionId), ["A", "B"])
    assert(effectsOfType(first, "deliver_channel_event")[0].content.includes("10.0 GB free"))
    assertEquals(effectsOfType(first, "send_text_to_user").length, 1)
    assert(typeof first.stateChanges.chatState.diskGuardLowSince === "number")

    const again = await diskGuard({ type: "disk_guard_check", freeGb: 9, path: "/data" }, lowCore(Date.now()))
    assertEquals(effectsOfType(again, "deliver_channel_event").length, 2, "re-warns while still low")
    assertEquals(effectsOfType(again, "send_text_to_user").length, 0, "Jeff is not re-pinged")
})

Deno.test("back over the limit clears once, then stays quiet", async () => {
    const clear = await diskGuard({ type: "disk_guard_check", freeGb: 60, path: "/data" }, lowCore(Date.now()))
    assertEquals(effectsOfType(clear, "deliver_channel_event").length, 0)
    assert(effectsOfType(clear, "send_text_to_user")[0].text.includes("cleared"))
    assert("diskGuardLowSince" in clear.stateChanges.chatState)
    assertEquals(clear.stateChanges.chatState.diskGuardLowSince, undefined)

    assertEquals(await diskGuard({ type: "disk_guard_check", freeGb: 60, path: "/data" }, lowCore(undefined)), null)
})

Deno.test("each tick reschedules itself every 30 s and measures the disk", () => {
    const tick = handleTick({ type: "disk_guard_tick" }, makeCore({}))
    assertEquals(tick.effects.map((e) => e.type), ["set_timer", "measure_disk_free"])
    assertEquals(tick.effects[0].delayMs, 30_000)
    assertEquals(tick.effects[0].event.type, "disk_guard_tick")
})
