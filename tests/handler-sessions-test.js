// tests/handler-sessions-test.js
//
// Unit tests for the session lifecycle handlers:
//   - session-register
//   - session-unregister
//   - ipc-connection-closed

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, makeCore, fakeConn, effectsOfType, get } from "./_helpers.js"

setupTempPaths("cbg-sessions-test-")

const register = (await import("../lib/event-handlers/session-register.js")).default
const unregister = (await import("../lib/event-handlers/session-unregister.js")).default
const ipcClosed = (await import("../lib/event-handlers/ipc-connection-closed.js")).default
const forceClose = (await import("../lib/event-handlers/session-force-close.js")).default

function regEvent(id, overrides = {}) {
    return {
        type: "session_register",
        ts: 5_000,
        session: { id, pid: 9999, cwd: "/tmp", dtachSocket: "/tmp/dtach.sock" },
        _conn: fakeConn(`conn-${id}`),
        ...overrides,
    }
}

// ── session_register ────────────────────────────────────────────────

Deno.test("session-register: invalid event (no id) returns null", () => {
    const core = makeCore()
    const action = register({ type: "session_register", session: {}, _conn: {} }, core)
    assertEquals(action, null)
})

Deno.test("session-register: first session auto-focuses", () => {
    const core = makeCore({ chatState: { focusedSessionId: null } })
    const action = register(regEvent("s1"), core)
    assertEquals(get(action, "stateChanges.chatState.focusedSessionId"), "s1")
    const sessionPatch = get(action, "stateChanges.chatSessions.s1")
    assertEquals(sessionPatch.id, "s1")
    assertEquals(sessionPatch.lastActive, 5_000)
})

Deno.test("session-register: reconnect preserves prior lastActive", () => {
    // Session "s1" was registered previously and later did real work at
    // ts=3_000_000. The daemon restarts; on reload chatSessions still
    // has the s1 entry (with lastActive=3_000_000) but no _conn. When
    // the shim reconnects and re-registers at event.ts=5_000, the
    // handler must NOT clobber lastActive back to 5_000 — registration
    // is not activity.
    const core = makeCore({
        chatState: { focusedSessionId: null },
        chatSessions: { "s1": { id: "s1", lastActive: 3_000_000 } },
    })
    const action = register(regEvent("s1"), core)
    const sessionPatch = get(action, "stateChanges.chatSessions.s1")
    assertEquals(sessionPatch.lastActive, 3_000_000)
})

Deno.test("session-register: additional session does NOT steal focus", () => {
    const core = makeCore({
        chatState: { focusedSessionId: "existing" },
        chatSessions: { "existing": { id: "existing", _conn: {} } },
    })
    const action = register(regEvent("s2"), core)
    // chatState patch should be absent or have no focusedSessionId
    assertEquals(get(action, "stateChanges.chatState.focusedSessionId"), undefined)
})

Deno.test("session-register: pendingFocusId gets promoted", () => {
    const core = makeCore({
        chatState: { focusedSessionId: null, pendingFocusId: "s1" },
    })
    const action = register(regEvent("s1"), core)
    assertEquals(get(action, "stateChanges.chatState.focusedSessionId"), "s1")
    assertEquals(get(action, "stateChanges.chatState.pendingFocusId"), undefined)
})

Deno.test("session-register: replies to shim with sessions summary", () => {
    const core = makeCore({ chatState: { focusedSessionId: null } })
    const action = register(regEvent("s1"), core)
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc.length, 1)
    assertEquals(ipc[0].message.type, "registered")
    assertEquals(ipc[0].message.focusedId, "s1")
    assertEquals(ipc[0].message.sessions.length, 1)
    assertEquals(ipc[0].message.sessions[0].id, "s1")
})

Deno.test("session-register: clears stale activeSpinner when re-registering the same session id", () => {
    const core = makeCore({
        chatState: { focusedSessionId: "s1" },
        chatSessions: {
            "s1": {
                id: "s1",
                activeSpinner: {
                    chatId: "42",
                    messageId: "999",
                    headerHtml: "stale",
                    items: [{ rendered: "• stale item" }],
                },
            },
        },
    })
    const action = register(regEvent("s1"), core)
    // The patch must carry an explicit undefined sentinel so
    // mergeSessionData deletes the key.
    const patch = get(action, "stateChanges.chatSessions.s1")
    assertEquals(patch.activeSpinner, undefined)
    assert("activeSpinner" in patch, "register patch must explicitly clear activeSpinner")
})

Deno.test("session-register: drains queued messages when auto-focusing", () => {
    const core = makeCore({
        chatState: {
            focusedSessionId: null,
            messageQueue: [
                { content: "queued one", meta: { chat_id: "42", message_id: "1" } },
                { content: "queued two", meta: { chat_id: "42", message_id: "2" } },
            ],
        },
    })
    const action = register(regEvent("s1"), core)
    const delivers = effectsOfType(action, "deliver_channel_event")
    assertEquals(delivers.length, 2)
    assertEquals(delivers[0].content, "queued one")
    assertEquals(delivers[1].content, "queued two")
    assertEquals(get(action, "stateChanges.chatState.messageQueue"), [])
})

// ── session_unregister ──────────────────────────────────────────────

Deno.test("session-unregister: removes the session via undefined sentinel", () => {
    const core = makeCore({
        chatState: { focusedSessionId: "other" },
        chatSessions: {
            "s1": { id: "s1", _conn: {} },
            "other": { id: "other", _conn: {} },
        },
    })
    const action = unregister({ sessionId: "s1", ts: 1 }, core)
    assertEquals(get(action, "stateChanges.chatSessions.s1"), undefined)
    assert("s1" in action.stateChanges.chatSessions)
})

Deno.test("session-unregister: clears focus when removing the focused session", () => {
    const core = makeCore({
        chatState: { focusedSessionId: "s1" },
        chatSessions: { "s1": { id: "s1", _conn: {} } },
    })
    const action = unregister({ sessionId: "s1", ts: 1 }, core)
    assertEquals(get(action, "stateChanges.chatState.focusedSessionId"), null)
})

Deno.test("session-unregister: unknown session returns null", () => {
    const core = makeCore({ chatSessions: {} })
    const action = unregister({ sessionId: "ghost" }, core)
    assertEquals(action, null)
})

Deno.test("session-unregister: invalid sessionId returns null", () => {
    const core = makeCore()
    assertEquals(unregister({ sessionId: null }, core), null)
    assertEquals(unregister({ sessionId: 42 }, core), null)
    assertEquals(unregister({ sessionId: "" }, core), null)
})

// ── ipc_connection_closed ───────────────────────────────────────────

Deno.test("ipc-closed: no _conn returns null", () => {
    const core = makeCore()
    assertEquals(ipcClosed({}, core), null)
})

Deno.test("ipc-closed: conn not tied to any session returns null (was a CLI conn)", () => {
    const core = makeCore({
        chatSessions: { "s1": { id: "s1", _conn: fakeConn("other") } },
    })
    assertEquals(ipcClosed({ _conn: fakeConn("different") }, core), null)
})

Deno.test("ipc-closed: matching conn removes the session", () => {
    const conn = fakeConn("s1-conn")
    const core = makeCore({
        chatState: { focusedSessionId: "s1" },
        chatSessions: { "s1": { id: "s1", _conn: conn } },
    })
    const action = ipcClosed({ _conn: conn }, core)
    assertEquals(get(action, "stateChanges.chatSessions.s1"), undefined)
    assertEquals(get(action, "stateChanges.chatState.focusedSessionId"), null)
})

Deno.test("ipc-closed: matching conn on non-focused session leaves focus alone", () => {
    const s1Conn = fakeConn("s1")
    const s2Conn = fakeConn("s2")
    const core = makeCore({
        chatState: { focusedSessionId: "s1" },
        chatSessions: {
            "s1": { id: "s1", _conn: s1Conn },
            "s2": { id: "s2", _conn: s2Conn },
        },
    })
    const action = ipcClosed({ _conn: s2Conn }, core)
    assertEquals(get(action, "stateChanges.chatSessions.s2"), undefined)
    assertEquals(get(action, "stateChanges.chatState"), undefined)
})

// ── session_force_close ────────────────────────────────────────────────

Deno.test("session-force-close: no-op when session already gone", () => {
    const core = makeCore({ chatState: {}, chatSessions: {} })
    const action = forceClose({ type: "session_force_close", sessionId: "gone" }, core)
    assertEquals(action, null)
})

Deno.test("session-force-close: SIGTERMs live session and drops it from state", () => {
    const core = makeCore({
        chatState: { focusedSessionId: "s1" },
        chatSessions: { "s1": { id: "s1", pid: 12345 } },
    })
    const action = forceClose(
        { type: "session_force_close", sessionId: "s1", requestChatId: "42" },
        core,
    )
    const sigs = effectsOfType(action, "signal_process")
    assertEquals(sigs.length, 1)
    assertEquals(sigs[0].pid, 12345)
    assertEquals(sigs[0].signal, "SIGTERM")
    assertEquals(get(action, "stateChanges.chatSessions.s1"), undefined)
    assertEquals(get(action, "stateChanges.chatState.focusedSessionId"), null)
    const notices = effectsOfType(action, "send_text_to_user")
    assertEquals(notices.length, 1)
    assertEquals(notices[0].chatId, "42")
})

Deno.test("session-force-close: leaves focus alone when a different session is focused", () => {
    const core = makeCore({
        chatState: { focusedSessionId: "other" },
        chatSessions: { "s1": { id: "s1", pid: 12345 } },
    })
    const action = forceClose({ type: "session_force_close", sessionId: "s1" }, core)
    assertEquals(get(action, "stateChanges.chatSessions.s1"), undefined)
    assertEquals(get(action, "stateChanges.chatState"), undefined)
})
