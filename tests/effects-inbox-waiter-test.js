// tests/effects-inbox-waiter-test.js
//
// Unit tests for lib/effects/inbox-waiter.js — the event-driven parking lot
// for `cbg ask --sync`. Each effect mutates core.inboxWaiters in place and
// writes/closes conns synchronously from the caller's POV.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, makeCore } from "./_helpers.js"

setupTempPaths("cbg-waiter-test-")

const { registerInboxWaiter, notifyInboxWaiter, clearInboxWaiterByConn, failInboxWaitersForSession } =
    await import("../lib/effects/inbox-waiter.js")

// A conn stub that records every write/close so the test can assert on it.
function recordingConn(label) {
    const writes = []
    let closed = false
    return {
        __label: label,
        get writes() { return writes },
        get closed() { return closed },
        write(bytes) { writes.push(new TextDecoder().decode(bytes)); return Promise.resolve() },
        read() { return Promise.resolve(null) },
        close() { closed = true },
    }
}

function extractJson(frameStr) {
    // encodeIpcFrame writes JSON + "\n"; strip and parse.
    return JSON.parse(frameStr.replace(/\n$/, ""))
}

Deno.test("waiter: register stores by address with conn and targetSessionId", () => {
    const core = makeCore()
    const conn = recordingConn("a")
    registerInboxWaiter({ address: "cli1", conn, targetSessionId: "Target" }, core)
    const w = core.inboxWaiters.get("cli1")
    assert(w !== undefined)
    assert(w.conn === conn)
    assertEquals(w.targetSessionId, "Target")
    assert(typeof w.askedAt === "number")
})

Deno.test("waiter: register a second waiter for same address evicts the first", () => {
    const core = makeCore()
    const first = recordingConn("first")
    const second = recordingConn("second")
    registerInboxWaiter({ address: "cli1", conn: first }, core)
    registerInboxWaiter({ address: "cli1", conn: second }, core)
    // first got an error frame + close
    assertEquals(first.writes.length, 1)
    assertEquals(extractJson(first.writes[0]).ok, false)
    assert(first.closed)
    // second is the current waiter
    assert(core.inboxWaiters.get("cli1").conn === second)
})

Deno.test("waiter: notify writes message + closes + deletes entry", async () => {
    const core = makeCore()
    const conn = recordingConn("a")
    registerInboxWaiter({ address: "cli1", conn }, core)
    await notifyInboxWaiter({ address: "cli1", message: { text: "reply" } }, core)
    assertEquals(conn.writes.length, 1)
    const frame = extractJson(conn.writes[0])
    assertEquals(frame.ok, true)
    assertEquals(frame.message.text, "reply")
    assert(conn.closed)
    assertEquals(core.inboxWaiters.has("cli1"), false)
})

Deno.test("waiter: notify on unknown address is a no-op", async () => {
    const core = makeCore()
    await notifyInboxWaiter({ address: "nobody", message: {} }, core)
    // No throw, no mutation — map stays empty (or never created).
    assertEquals(core.inboxWaiters?.size ?? 0, 0)
})

Deno.test("waiter: clearInboxWaiterByConn removes entries matching a conn", () => {
    const core = makeCore()
    const a = recordingConn("a")
    const b = recordingConn("b")
    registerInboxWaiter({ address: "cli1", conn: a }, core)
    registerInboxWaiter({ address: "cli2", conn: b }, core)
    clearInboxWaiterByConn({ conn: a }, core)
    assertEquals(core.inboxWaiters.has("cli1"), false)
    assertEquals(core.inboxWaiters.has("cli2"), true)
})

Deno.test("waiter: failInboxWaitersForSession errors+closes waiters targeting that session", () => {
    const core = makeCore()
    const a = recordingConn("a")
    const b = recordingConn("b")
    const c = recordingConn("c")
    registerInboxWaiter({ address: "cli1", conn: a, targetSessionId: "Dying" }, core)
    registerInboxWaiter({ address: "cli2", conn: b, targetSessionId: "OtherSession" }, core)
    registerInboxWaiter({ address: "cli3", conn: c, targetSessionId: "Dying" }, core)
    failInboxWaitersForSession({ sessionId: "Dying", reason: "unregistered (clean)" }, core)
    // cli1 and cli3 killed
    assert(a.closed)
    assert(c.closed)
    assertEquals(extractJson(a.writes[0]).ok, false)
    assert(extractJson(a.writes[0]).error.includes("Dying"))
    assertEquals(core.inboxWaiters.has("cli1"), false)
    assertEquals(core.inboxWaiters.has("cli3"), false)
    // cli2 survives
    assert(!b.closed)
    assertEquals(core.inboxWaiters.has("cli2"), true)
})
