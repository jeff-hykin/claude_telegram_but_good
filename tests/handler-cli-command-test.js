// tests/handler-cli-command-test.js
//
// Unit tests for lib/event-handlers/cli-command.js. Handles kinds:
//   - set_pending_otp
//   - reload_cbg
//   - get_cbg_version
//   - server_dump
//   - shutdown
//   - (unknown)

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, makeCore, fakeConn, effectsOfType, get } from "./_helpers.js"

setupTempPaths("cbg-cli-test-")

const handle = (await import("../lib/event-handlers/cli-command.js")).default

Deno.test("cli-command: set_pending_otp stores otp on chatState and replies closeAfter", () => {
    const core = makeCore()
    const conn = fakeConn("cli")
    const action = handle({
        kind: "set_pending_otp",
        payload: { otp: "XYZ123" },
        _conn: conn,
        ts: 10,
    }, core)
    const stored = get(action, "stateChanges.chatState.pendingOtps.XYZ123")
    assertEquals(stored.createdAt, 10)
    assertEquals(stored.chatId, null)
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc[0].message.ok, true)
    assertEquals(ipc[0].closeAfter, true)
})

Deno.test("cli-command: set_pending_otp without an otp replies with error", () => {
    const core = makeCore()
    const action = handle({
        kind: "set_pending_otp",
        payload: {},
        _conn: fakeConn(),
    }, core)
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc[0].message.ok, false)
})

Deno.test("cli-command: reload_cbg emits bump_cbg_version + reply with projected version", () => {
    const core = makeCore()
    const prev = globalThis.cbgVersion ?? 1
    const action = handle({ kind: "reload_cbg", _conn: fakeConn() }, core)
    const bump = effectsOfType(action, "bump_cbg_version")
    assertEquals(bump.length, 1)
    assertEquals(bump[0].toVersion, prev + 1)
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc[0].message.version, prev + 1)
})

Deno.test("cli-command: get_cbg_version returns the current version", () => {
    const core = makeCore()
    const action = handle({ kind: "get_cbg_version", _conn: fakeConn() }, core)
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc[0].message.ok, true)
    assertEquals(typeof ipc[0].message.version, "number")
})

Deno.test("cli-command: server_dump writes a file and replies with the dump path", () => {
    const core = makeCore({
        chatState: { focusedSessionId: "s1" },
        chatSessions: { "s1": { id: "s1", _conn: fakeConn() } },
        specialData: { longTaskByChatId: {} },
    })
    const action = handle({ kind: "server_dump", payload: {}, _conn: fakeConn() }, core)
    const writes = effectsOfType(action, "write_file")
    assertEquals(writes.length, 1)
    assert(writes[0].path.includes(".cbg-dump.json"))
    const parsed = JSON.parse(writes[0].content)
    assertEquals(parsed.chatState.focusedSessionId, "s1")
    // Underscore-prefixed keys (_conn) must be stripped from the dumped state
    assertEquals("_conn" in parsed.chatSessions.s1, false)
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc[0].message.ok, true)
    assert(typeof ipc[0].message.dumpPath === "string")
})

Deno.test("cli-command: server_dump honors a caller-supplied targetPath", () => {
    const core = makeCore()
    const action = handle({
        kind: "server_dump",
        payload: { targetPath: "/tmp/explicit-dump.json" },
        _conn: fakeConn(),
    }, core)
    const writes = effectsOfType(action, "write_file")
    assertEquals(writes[0].path, "/tmp/explicit-dump.json")
})

Deno.test("cli-command: shutdown replies ok", () => {
    const core = makeCore()
    const action = handle({ kind: "shutdown", _conn: fakeConn() }, core)
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc[0].message.ok, true)
    assertEquals(ipc[0].closeAfter, true)
})

Deno.test("cli-command: unknown kind replies with an error", () => {
    const core = makeCore()
    const action = handle({ kind: "made_up", _conn: fakeConn() }, core)
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc[0].message.ok, false)
    assertEquals(ipc[0].message.error, "unknown kind")
})
