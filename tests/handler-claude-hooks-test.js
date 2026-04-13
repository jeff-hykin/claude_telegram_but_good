// tests/handler-claude-hooks-test.js
//
// Unit tests for the three Claude Code hook handlers:
//   - claude-hook-pre-tool-use
//   - claude-hook-post-tool-use
//   - claude-hook-stop
//
// All three follow the same bail-early rules (no sessionId, session
// unknown, session not focused), so the tests cluster around those
// invariants plus each handler's special behavior (spinner append on
// pre/post, nudge watchdog on stop).

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, makeCore, effectsOfType, get } from "./_helpers.js"

setupTempPaths("cbg-hooks-test-")

const pre = (await import("../lib/event-handlers/claude-hook-pre-tool-use.js")).default
const post = (await import("../lib/event-handlers/claude-hook-post-tool-use.js")).default
const stop = (await import("../lib/event-handlers/claude-hook-stop.js")).default

function session(id, patch = {}) {
    return { id, pid: 1234, _conn: {}, ...patch }
}

function preEvent(overrides = {}) {
    return {
        type: "claude_hook_pre_tool_use",
        ts: 5_000,
        sessionId: "sess-1",
        claudePid: 1234,
        toolName: "Read",
        inputPreview: JSON.stringify({ file_path: "/tmp/a.js" }),
        outputPreview: "",
        isError: false,
        ...overrides,
    }
}

function postEvent(overrides = {}) {
    return { ...preEvent(overrides), type: "claude_hook_post_tool_use" }
}

function stopEvent(overrides = {}) {
    return {
        type: "claude_hook_stop",
        ts: 6_000,
        sessionId: "sess-1",
        claudePid: 1234,
        ...overrides,
    }
}

// ── pre-tool-use ────────────────────────────────────────────────────

Deno.test("hook-pre: no sessionId -> no-op", () => {
    const core = makeCore()
    const action = pre(preEvent({ sessionId: null }), core)
    assertEquals(action.effects, [])
})

Deno.test("hook-pre: unknown session -> no-op", () => {
    const core = makeCore({ chatState: { focusedSessionId: "sess-1" }, chatSessions: {} })
    const action = pre(preEvent(), core)
    assertEquals(action.effects, [])
})

Deno.test("hook-pre: non-focused session -> no-op", () => {
    const core = makeCore({
        chatState: { focusedSessionId: "other" },
        chatSessions: { "sess-1": session("sess-1"), "other": session("other") },
    })
    const action = pre(preEvent(), core)
    assertEquals(action.effects, [])
})

Deno.test("hook-pre: focused session emits append_tool_to_spinner + cold_append", () => {
    const core = makeCore({
        chatState: { focusedSessionId: "sess-1" },
        chatSessions: { "sess-1": session("sess-1") },
    })
    const action = pre(preEvent(), core)
    assertEquals(effectsOfType(action, "append_tool_to_spinner").length, 1)
    const cold = effectsOfType(action, "cold_append")
    assertEquals(cold.length, 1)
    assertEquals(cold[0].stream, "hooks")
    assertEquals(cold[0].entry.kind, "pre_tool_use")
    assertEquals(get(action, "stateChanges.chatSessions.sess-1.lastActive"), 5_000)
})

Deno.test("hook-pre: hidden telegram-plugin tools still update lastActive but emit no effects", () => {
    const core = makeCore({
        chatState: { focusedSessionId: "sess-1" },
        chatSessions: { "sess-1": session("sess-1") },
    })
    const action = pre(preEvent({
        toolName: "mcp__plugin_telegram_telegram__reply",
    }), core)
    assertEquals(action.effects, [])
    assertEquals(get(action, "stateChanges.chatSessions.sess-1.lastActive"), 5_000)
})

// ── post-tool-use ───────────────────────────────────────────────────

Deno.test("hook-post: focused session emits append_tool_to_spinner + cold_append", () => {
    const core = makeCore({
        chatState: { focusedSessionId: "sess-1" },
        chatSessions: { "sess-1": session("sess-1") },
    })
    const action = post(postEvent({ outputPreview: "\"ok\"" }), core)
    assertEquals(effectsOfType(action, "append_tool_to_spinner").length, 1)
    const cold = effectsOfType(action, "cold_append")
    assertEquals(cold[0].entry.kind, "post_tool_use")
    assertEquals(cold[0].entry.isError, false)
})

Deno.test("hook-post: error result is recorded", () => {
    const core = makeCore({
        chatState: { focusedSessionId: "sess-1" },
        chatSessions: { "sess-1": session("sess-1") },
    })
    const action = post(postEvent({ isError: true }), core)
    assertEquals(effectsOfType(action, "cold_append")[0].entry.isError, true)
})

// ── stop ─────────────────────────────────────────────────────────────

Deno.test("hook-stop: records lastStopAt + cold_append even with no inbound", () => {
    const core = makeCore({
        chatSessions: { "sess-1": session("sess-1") },
    })
    const action = stop(stopEvent(), core)
    assertEquals(get(action, "stateChanges.chatSessions.sess-1.lastStopAt"), 6_000)
    assertEquals(get(action, "stateChanges.chatSessions.sess-1.lastActive"), 6_000)
    assertEquals(effectsOfType(action, "cold_append").length, 1)
    assertEquals(effectsOfType(action, "send_text_to_claude").length, 0)
})

Deno.test("hook-stop: nudges when an old unreplied inbound exists", () => {
    const core = makeCore({
        chatSessions: {
            "sess-1": session("sess-1", {
                lastInbound: { messageId: "1", chatId: "42", ts: 1, text: "poke" },
                lastOutboundAt: 0,
                nudgedForInbound: false,
            }),
        },
    })
    const action = stop(stopEvent({ ts: 100_000 }), core)
    const nudges = effectsOfType(action, "send_text_to_claude")
    assertEquals(nudges.length, 1)
    assert(nudges[0].text.includes("automated reminder"))
    assertEquals(get(action, "stateChanges.chatSessions.sess-1.nudgedForInbound"), true)
})

Deno.test("hook-stop: does NOT nudge when the inbound is under the 45s threshold", () => {
    const core = makeCore({
        chatSessions: {
            "sess-1": session("sess-1", {
                lastInbound: { messageId: "1", chatId: "42", ts: 1, text: "poke" },
                lastOutboundAt: 0,
            }),
        },
    })
    const action = stop(stopEvent({ ts: 30_000 }), core)
    assertEquals(effectsOfType(action, "send_text_to_claude").length, 0)
})

Deno.test("hook-stop: does NOT nudge when agent already replied since the inbound", () => {
    const core = makeCore({
        chatSessions: {
            "sess-1": session("sess-1", {
                lastInbound: { messageId: "1", chatId: "42", ts: 0, text: "poke" },
                lastOutboundAt: 50_000,
            }),
        },
    })
    const action = stop(stopEvent({ ts: 100_000 }), core)
    assertEquals(effectsOfType(action, "send_text_to_claude").length, 0)
})

Deno.test("hook-stop: does NOT nudge twice for the same inbound", () => {
    const core = makeCore({
        chatSessions: {
            "sess-1": session("sess-1", {
                lastInbound: { messageId: "1", chatId: "42", ts: 1, text: "poke" },
                lastOutboundAt: 0,
                nudgedForInbound: true,
            }),
        },
    })
    const action = stop(stopEvent({ ts: 100_000 }), core)
    assertEquals(effectsOfType(action, "send_text_to_claude").length, 0)
})

Deno.test("hook-stop: missing session -> no-op", () => {
    const core = makeCore({ chatSessions: {} })
    const action = stop(stopEvent(), core)
    assertEquals(action.effects, [])
})
