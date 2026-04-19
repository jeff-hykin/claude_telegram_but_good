// tests/handler-session-register-no-dtach-test.js
//
// Unit tests for the follow-up handler that fires when a shim registers
// without dtach in its ancestry. The handler is responsible for logging,
// hour-long debouncing keyed on cwd, and (only when a user is paired)
// emitting one Telegram warning per allowFrom chat.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, writeAccess, makeCore, effectsOfType, get } from "./_helpers.js"

setupTempPaths("cbg-no-dtach-test-")

const handler = (await import("../lib/event-handlers/session-register-no-dtach.js")).default

function makeEvent(overrides = {}) {
    return {
        type: "session_register_no_dtach",
        sessionId: "SurprisingRooster",
        cwd: "/repo/foo",
        gitBranch: "master",
        pid: 1234,
        ts: 10_000,
        ...overrides,
    }
}

Deno.test("no-dtach: invalid event (no sessionId) returns null", () => {
    writeAccess(["42"])
    const core = makeCore()
    assertEquals(handler({ type: "session_register_no_dtach" }, core), null)
})

Deno.test("no-dtach: no paired chats -> logs only, no effects, no state changes", () => {
    writeAccess([])
    const core = makeCore()
    const action = handler(makeEvent(), core)
    // Handler returns null when there's nobody to warn — we purposely
    // don't burn a debounce slot in that case so the very first paired
    // user still gets their warning immediately.
    assertEquals(action, null)
})

Deno.test("no-dtach: emits one send_text_to_user effect per paired chat", () => {
    writeAccess(["42", "99"])
    const core = makeCore()
    const action = handler(makeEvent(), core)
    const sends = effectsOfType(action, "send_text_to_user")
    assertEquals(sends.length, 2)
    assertEquals(sends[0].replyTo.chatId, "42")
    assertEquals(sends[1].replyTo.chatId, "99")
    // Each warning should mention the sessionId and cwd
    assert(sends[0].text.includes("SurprisingRooster"))
    assert(sends[0].text.includes("/repo/foo"))
    assert(sends[0].text.includes("cbg reinstall"))
    assertEquals(sends[0].options.parse_mode, "HTML")
})

Deno.test("no-dtach: records warning timestamp in chatState.noDtachWarnings", () => {
    writeAccess(["42"])
    const core = makeCore()
    const action = handler(makeEvent({ ts: 50_000 }), core)
    assertEquals(get(action, "stateChanges.chatState.noDtachWarnings./repo/foo"), 50_000)
})

Deno.test("no-dtach: debounces repeat warnings within 1 hour (same cwd)", () => {
    writeAccess(["42"])
    const core = makeCore({
        chatState: {
            noDtachWarnings: { "/repo/foo": 10_000 },
        },
    })
    // 30 minutes later — still inside debounce window
    const action = handler(makeEvent({ ts: 10_000 + 30 * 60 * 1000 }), core)
    assertEquals(action, null)
})

Deno.test("no-dtach: re-warns for same cwd after 1+ hour", () => {
    writeAccess(["42"])
    const core = makeCore({
        chatState: {
            noDtachWarnings: { "/repo/foo": 10_000 },
        },
    })
    // Just over an hour later
    const action = handler(makeEvent({ ts: 10_000 + 61 * 60 * 1000 }), core)
    assert(action != null)
    const sends = effectsOfType(action, "send_text_to_user")
    assertEquals(sends.length, 1)
})

Deno.test("no-dtach: different cwds have independent debounce windows", () => {
    writeAccess(["42"])
    const core = makeCore({
        chatState: {
            noDtachWarnings: { "/repo/foo": 10_000 },
        },
    })
    // Different cwd — should warn immediately
    const action = handler(makeEvent({ cwd: "/repo/bar", ts: 15_000 }), core)
    assert(action != null)
    assertEquals(effectsOfType(action, "send_text_to_user").length, 1)
    assertEquals(get(action, "stateChanges.chatState.noDtachWarnings./repo/bar"), 15_000)
})
