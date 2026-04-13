// tests/handler-server-dump-test.js
//
// Unit tests for lib/event-handlers/server-dump.js. The handler serves
// two sources ("telegram" from an admin dump command, "mcp_tool" from
// the cbg_debug MCP tool) and an unknown-source path.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, makeCore, fakeConn, effectsOfType, get } from "./_helpers.js"

setupTempPaths("cbg-srvdump-test-")

const handle = (await import("../lib/event-handlers/server-dump.js")).default

function coreWithState() {
    return makeCore({
        chatState: { focusedSessionId: "s1", pendingOtps: { abc: {} } },
        chatSessions: {
            "s1": {
                id: "s1",
                cwd: "/tmp",
                _conn: { write: () => {} },  // should be stripped from dump
            },
        },
        specialData: {
            longTaskByChatId: { "42": { "t1": { id: "t1", state: "defining" } } },
        },
    })
}

Deno.test("server-dump: telegram source writes file + sends it back to the chat", () => {
    const core = coreWithState()
    const action = handle({
        source: "telegram",
        chatId: "42",
        ts: 1,
    }, core)
    const writes = effectsOfType(action, "write_file")
    assertEquals(writes.length, 1)
    const sends = effectsOfType(action, "send_file_to_user")
    assertEquals(sends.length, 1)
    assertEquals(sends[0].chatId, "42")
    assertEquals(sends[0].filename, "cbg-dump.json")
    assertEquals(sends[0].filePath, writes[0].path)
})

Deno.test("server-dump: mcp_tool source replies over the shim conn with tool_response", () => {
    const core = coreWithState()
    const conn = fakeConn("shim")
    const action = handle({
        source: "mcp_tool",
        requestId: "req-1",
        _conn: conn,
        ts: 1,
    }, core)
    const writes = effectsOfType(action, "write_file")
    assertEquals(writes.length, 1)
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc.length, 1)
    assertEquals(ipc[0].conn, conn)
    assertEquals(ipc[0].message.type, "tool_response")
    assertEquals(ipc[0].message.requestId, "req-1")
    // closeAfter is NOT set (shim conn is long-lived)
    assertEquals(ipc[0].closeAfter, undefined)
    // Payload contains logPath and dumpPath
    const payloadText = ipc[0].message.result.content[0].text
    const parsed = JSON.parse(payloadText)
    assertEquals(typeof parsed.logPath, "string")
    assertEquals(typeof parsed.dumpPath, "string")
})

Deno.test("server-dump: unknown source still writes the file but no other effect", () => {
    const core = coreWithState()
    const action = handle({ source: "weird", ts: 1 }, core)
    assertEquals(effectsOfType(action, "write_file").length, 1)
    assertEquals(effectsOfType(action, "send_file_to_user").length, 0)
    assertEquals(effectsOfType(action, "ipc_respond").length, 0)
})

Deno.test("server-dump: dump content strips underscore-prefixed keys (_conn)", () => {
    const core = coreWithState()
    const action = handle({ source: "telegram", chatId: "42" }, core)
    const writes = effectsOfType(action, "write_file")
    const parsed = JSON.parse(writes[0].content)
    assertEquals("_conn" in parsed.chatSessions.s1, false)
    assertEquals(parsed.chatSessions.s1.id, "s1")
})

Deno.test("server-dump: targetPath override is honored", () => {
    const core = coreWithState()
    const action = handle({
        source: "telegram",
        chatId: "42",
        targetPath: "/tmp/explicit.json",
    }, core)
    assertEquals(effectsOfType(action, "write_file")[0].path, "/tmp/explicit.json")
})
