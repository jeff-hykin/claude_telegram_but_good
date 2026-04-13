// tests/handler-download-complete-test.js
//
// Unit tests for download-complete-for-tool.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, makeCore, fakeConn, effectsOfType } from "./_helpers.js"

setupTempPaths("cbg-dlcomplete-test-")

const dlHandle = (await import("../lib/event-handlers/download-complete-for-tool.js")).default

Deno.test("download-complete: success replies with the downloaded path", () => {
    const core = makeCore()
    const conn = fakeConn("shim")
    const action = dlHandle({
        fileId: "ABC",
        requestId: "r1",
        imagePath: "/tmp/inbox/abc.jpg",
        _conn: conn,
    }, core)
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc.length, 1)
    assertEquals(ipc[0].conn, conn)
    assertEquals(ipc[0].message.requestId, "r1")
    assert(ipc[0].message.result.content[0].text.includes("/tmp/inbox/abc.jpg"))
    assertEquals(ipc[0].message.result.isError, undefined)
})

Deno.test("download-complete: failure (null imagePath) replies with error", () => {
    const core = makeCore()
    const action = dlHandle({
        fileId: "ABC",
        requestId: "r1",
        imagePath: null,
        _conn: fakeConn(),
    }, core)
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc[0].message.result.isError, true)
    assert(ipc[0].message.result.content[0].text.includes("failed"))
})

Deno.test("download-complete: missing _conn is a no-op (nothing to reply to)", () => {
    const core = makeCore()
    const action = dlHandle({
        fileId: "ABC",
        requestId: "r1",
        imagePath: "/tmp/x.jpg",
    }, core)
    assertEquals(action.effects, [])
})

Deno.test("download-complete: missing requestId is a no-op", () => {
    const core = makeCore()
    const action = dlHandle({
        fileId: "ABC",
        imagePath: "/tmp/x.jpg",
        _conn: fakeConn(),
    }, core)
    assertEquals(action.effects, [])
})

