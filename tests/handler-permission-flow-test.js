// tests/handler-permission-flow-test.js
//
// Unit tests for the permission-request + telegram-callback-query pair.
// permission-request stashes pending permissions and fans out a
// one-message-per-chat prompt; the callback-query handler resolves them
// via Allow/Deny button taps.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, writeAccess, makeCore, fakeConn, effectsOfType, get } from "./_helpers.js"

setupTempPaths("cbg-permflow-test-")
writeAccess(["42", "99"])

const permReq = (await import("../lib/event-handlers/permission-request.js")).default
const tgCbq = (await import("../lib/event-handlers/telegram-callback-query.js")).default

// ── permission-request ─────────────────────────────────────────────

Deno.test("permission-request: invalid event (no requestId) returns empty action", () => {
    const core = makeCore()
    const action = permReq({ toolName: "Edit" }, core)
    assertEquals(action.effects, [])
})

Deno.test("permission-request: stashes pending permission in chatState", () => {
    const core = makeCore()
    const conn = fakeConn("shim")
    const action = permReq({
        sessionId: "s1",
        requestId: "req-xyz",
        toolName: "Edit",
        description: "edit /tmp/x.js",
        inputPreview: `{"file_path":"/tmp/x.js"}`,
        ts: 123,
        _conn: conn,
    }, core)
    const stored = get(action, "stateChanges.chatState.pendingPermissions.req-xyz")
    assertEquals(stored.sessionId, "s1")
    assertEquals(stored.toolName, "Edit")
    assertEquals(stored._conn, conn)
})

Deno.test("permission-request: emits one message per allowFrom chat", () => {
    const core = makeCore()
    const action = permReq({
        sessionId: "s1",
        requestId: "req-1",
        toolName: "Edit",
        description: "desc",
        inputPreview: "{}",
        ts: 1,
        _conn: fakeConn(),
    }, core)
    const sends = effectsOfType(action, "send_text_to_user")
    assertEquals(sends.length, 2)
    // Each message carries the Allow/Deny keyboard
    for (const s of sends) {
        assert(Array.isArray(s.options.reply_markup.inline_keyboard))
        const btns = s.options.reply_markup.inline_keyboard[0]
        assertEquals(btns[0].callback_data, "perm:allow:req-1")
        assertEquals(btns[1].callback_data, "perm:deny:req-1")
    }
})

Deno.test("permission-request: truncates enormous inputPreview before embedding", () => {
    const core = makeCore()
    const huge = "A".repeat(5000)
    const action = permReq({
        sessionId: "s1",
        requestId: "req-2",
        toolName: "Edit",
        inputPreview: huge,
        ts: 1,
        _conn: fakeConn(),
    }, core)
    const sends = effectsOfType(action, "send_text_to_user")
    assert(sends[0].text.includes("truncated"))
    assert(sends[0].text.length < 4096)
})

// ── telegram-callback-query: perm flow ─────────────────────────────

Deno.test("tg-cbq: perm:allow unblocks the worker conn with allow + confirms to chat", () => {
    const conn = fakeConn("shim")
    const core = makeCore({
        chatState: {
            pendingPermissions: {
                "req-1": {
                    sessionId: "s1", toolName: "Edit", _conn: conn,
                },
            },
        },
    })
    const action = tgCbq({
        data: "perm:allow:req-1",
        chatId: "42",
        queryId: "q-1",
    }, core)
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc.length, 1)
    assertEquals(ipc[0].conn, conn)
    assertEquals(ipc[0].message.type, "permission_reply")
    assertEquals(ipc[0].message.behavior, "allow")
    assertEquals(ipc[0].message.request_id, "req-1")

    // pending entry deleted
    assertEquals(get(action, "stateChanges.chatState.pendingPermissions.req-1"), undefined)

    // Confirmation message + answer_callback_query both queued
    assertEquals(effectsOfType(action, "send_text_to_user").length, 1)
    assertEquals(effectsOfType(action, "answer_callback_query").length, 1)
})

Deno.test("tg-cbq: perm:deny unblocks the worker conn with deny", () => {
    const core = makeCore({
        chatState: {
            pendingPermissions: {
                "req-2": { sessionId: "s1", toolName: "Edit", _conn: fakeConn() },
            },
        },
    })
    const action = tgCbq({
        data: "perm:deny:req-2",
        chatId: "42",
        queryId: "q-2",
    }, core)
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc[0].message.behavior, "deny")
})

Deno.test("tg-cbq: perm for unknown requestId reports expired", () => {
    const core = makeCore({ chatState: { pendingPermissions: {} } })
    const action = tgCbq({
        data: "perm:allow:ghost",
        chatId: "42",
        queryId: "q-3",
    }, core)
    // No ipc_respond to a worker — only user + callback answer
    assertEquals(effectsOfType(action, "ipc_respond").length, 0)
    const answers = effectsOfType(action, "answer_callback_query")
    assertEquals(answers[0].text, "expired")
})

Deno.test("tg-cbq: malformed perm callback is ignored", () => {
    const core = makeCore({ chatState: { pendingPermissions: {} } })
    const action = tgCbq({ data: "perm:yolo", chatId: "42" }, core)
    assertEquals(action.effects, [])
})

Deno.test("tg-cbq: empty data string is a no-op", () => {
    const core = makeCore()
    const action = tgCbq({ data: "" }, core)
    assertEquals(action.effects, [])
})

// ── telegram-callback-query: cmderr fix flow ───────────────────────

Deno.test("tg-cbq: cmderr:fix forwards the error to the focused session", () => {
    const core = makeCore({
        chatState: {
            focusedSessionId: "sess-1",
            commandErrors: {
                "err-1": {
                    cmdName: "list",
                    error: "oops",
                    stack: "Error: oops\n  at ...",
                    originalText: "/list",
                },
            },
        },
    })
    const action = tgCbq({
        data: "cmderr:fix:err-1",
        chatId: "42",
        queryId: "q-4",
    }, core)
    const delivers = effectsOfType(action, "deliver_channel_event")
    assertEquals(delivers.length, 1)
    assertEquals(delivers[0].sessionId, "sess-1")
    assert(delivers[0].content.includes("oops"))
    assertEquals(get(action, "stateChanges.chatState.commandErrors.err-1"), undefined)
})

Deno.test("tg-cbq: cmderr:fix for unknown errorId tells the user it expired", () => {
    const core = makeCore({ chatState: { commandErrors: {} } })
    const action = tgCbq({
        data: "cmderr:fix:ghost",
        chatId: "42",
        queryId: "q-5",
    }, core)
    const sends = effectsOfType(action, "send_text_to_user")
    assert(sends[0].text.includes("not found"))
})

Deno.test("tg-cbq: cmderr:fix with no focused session refuses the forward", () => {
    const core = makeCore({
        chatState: {
            focusedSessionId: null,
            commandErrors: { "err-1": { cmdName: "x", error: "e", stack: "", originalText: "/x" } },
        },
    })
    const action = tgCbq({
        data: "cmderr:fix:err-1",
        chatId: "42",
        queryId: "q-6",
    }, core)
    assertEquals(effectsOfType(action, "deliver_channel_event").length, 0)
    const sends = effectsOfType(action, "send_text_to_user")
    assert(sends[0].text.includes("No focused session"))
})
