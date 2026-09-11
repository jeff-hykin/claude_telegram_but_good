// tests/slow-tool-watchdog-test.js
//
// The slow-tool watchdog end to end:
//   - pre-tool-use stamps session.activeTools and arms a slow_tool_check timer
//   - post-tool-use clears the entry and records the duration
//   - Stop clears every in-flight entry
//   - slow-tool-check backgrounds only a call that is still running, in a
//     topic that has not opted out, on a backend that can background tools
//   - stall-check treats an in-flight tool as busy, never stalled
//   - /auto_background stores per-topic overrides
//   - the Claude backend refuses to background anything but Bash

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, writeAccess, makeCore, effectsOfType, get } from "./_helpers.js"

setupTempPaths("cbg-slow-tool-test-")
writeAccess(["42"])

const pre = (await import("../lib/event-handlers/claude-hook-pre-tool-use.js")).default
const post = (await import("../lib/event-handlers/claude-hook-post-tool-use.js")).default
const stop = (await import("../lib/event-handlers/claude-hook-stop.js")).default
const slowToolCheck = (await import("../lib/event-handlers/slow-tool-check.js")).default
const stallCheck = (await import("../lib/event-handlers/stall-check.js")).default
const { parseAutoBackgroundArg, resolveAutoBackground } = await import("../lib/pure/auto-background.js")
const { commands: autoBackgroundCommands } = await import("../commands/auto_background.js")
const { backend: claudeBackend } = await import("../lib/agent-backends/claude.js")
const { SESSION_FIELDS_RESET_ON_RESTART } = await import("../lib/pure/field-stripper.js")

const CC_CHAT = "-100777"
const THREAD = 34235
const KEY = `${CC_CHAT}:${THREAD}`

function session(id, patch = {}) {
    return { id, pid: 1234, _conn: {}, dtachSocket: `/tmp/dtach-${id}.sock`, ...patch }
}

/** A core where session "sess-1" is the mapped session of topic THREAD. */
function topicCore({ chatState = {}, sessionPatch = {} } = {}) {
    return makeCore({
        chatState: {
            focusedSessionId: "sess-1",
            commandCenter: { chatId: CC_CHAT, topicMap: { "sess-1": THREAD }, threadMap: { [String(THREAD)]: "sess-1" } },
            ...chatState,
        },
        chatSessions: { "sess-1": session("sess-1", sessionPatch) },
    })
}

function preEvent(overrides = {}) {
    return {
        type: "claude_hook_pre_tool_use",
        ts: 5_000,
        sessionId: "sess-1",
        claudePid: 1234,
        toolName: "Bash",
        toolUseId: "toolu_1",
        inputPreview: JSON.stringify({ command: "sleep 100" }),
        outputPreview: "",
        isError: false,
        ...overrides,
    }
}

function postEvent(overrides = {}) {
    return { ...preEvent({ ts: 500_000, ...overrides }), type: "claude_hook_post_tool_use" }
}

function checkEvent(overrides = {}) {
    return { type: "slow_tool_check", ts: 15_000, sessionId: "sess-1", toolUseId: "toolu_1", ...overrides }
}

// ── pure helpers ──────────────────────────────────────────────────────

Deno.test("auto-background: parseAutoBackgroundArg", () => {
    assertEquals(parseAutoBackgroundArg("on"), { value: undefined })
    assertEquals(parseAutoBackgroundArg("OFF"), { value: { enabled: false } })
    assertEquals(parseAutoBackgroundArg("30"), { value: { thresholdMs: 30_000 } })
    assertEquals(parseAutoBackgroundArg("45s"), { value: { thresholdMs: 45_000 } })
    assertEquals(parseAutoBackgroundArg("2m"), { value: { thresholdMs: 120_000 } })
    assert(parseAutoBackgroundArg("soon").error)
    assert(parseAutoBackgroundArg("0").error)
})

Deno.test("auto-background: resolve defaults to on at the config threshold", () => {
    assertEquals(resolveAutoBackground({}, KEY, 10_000), { enabled: true, thresholdMs: 10_000, overridden: false })
    assertEquals(resolveAutoBackground({}, null, 10_000), { enabled: true, thresholdMs: 10_000, overridden: false })
    assertEquals(
        resolveAutoBackground({ autoBackground: { [KEY]: { enabled: false } } }, KEY, 10_000),
        { enabled: false, thresholdMs: 10_000, overridden: true },
    )
    assertEquals(
        resolveAutoBackground({ autoBackground: { [KEY]: { thresholdMs: 30_000 } } }, KEY, 10_000),
        { enabled: true, thresholdMs: 30_000, overridden: true },
    )
})

// ── pre / post / stop bookkeeping ────────────────────────────────────

Deno.test("hook-pre: records the call in activeTools and arms slow_tool_check", () => {
    const core = topicCore()
    const action = pre(preEvent(), core)
    assertEquals(get(action, "stateChanges.chatSessions.sess-1.activeTools.toolu_1"), { toolName: "Bash", startedAt: 5_000 })
    const timers = effectsOfType(action, "set_timer")
    assertEquals(timers.length, 1)
    assertEquals(timers[0].delayMs, 10_000)
    assertEquals(timers[0].event, { type: "slow_tool_check", sessionId: "sess-1", toolUseId: "toolu_1" })
})

Deno.test("hook-pre: a topic override changes the timer delay", () => {
    const core = topicCore({ chatState: { autoBackground: { [KEY]: { thresholdMs: 30_000 } } } })
    const action = pre(preEvent(), core)
    assertEquals(effectsOfType(action, "set_timer")[0].delayMs, 30_000)
})

Deno.test("hook-pre: /auto_background off arms no timer but still tracks the call", () => {
    const core = topicCore({ chatState: { autoBackground: { [KEY]: { enabled: false } } } })
    const action = pre(preEvent(), core)
    assertEquals(effectsOfType(action, "set_timer"), [])
    assertEquals(get(action, "stateChanges.chatSessions.sess-1.activeTools.toolu_1.toolName"), "Bash")
})

Deno.test("hook-pre: no tool_use_id → nothing tracked, no timer", () => {
    const core = topicCore()
    const action = pre(preEvent({ toolUseId: null }), core)
    assertEquals(effectsOfType(action, "set_timer"), [])
    assertEquals(get(action, "stateChanges.chatSessions.sess-1.activeTools"), undefined)
})

Deno.test("hook-post: clears the activeTools entry and records the duration", () => {
    const core = topicCore({ sessionPatch: { activeTools: { toolu_1: { toolName: "Bash", startedAt: 5_000 } } } })
    const action = post(postEvent(), core)
    // undefined in a patch deletes the key (lib/pure/state-merge.js)
    const patch = get(action, "stateChanges.chatSessions.sess-1.activeTools")
    assert("toolu_1" in patch && patch.toolu_1 === undefined)
    const cold = effectsOfType(action, "cold_append")
    assertEquals(cold[0].entry.durationMs, 495_000)
    assertEquals(cold[0].entry.backgrounded, false)
})

Deno.test("hook-post: a backgrounded call is flagged in the cold entry", () => {
    const core = topicCore({ sessionPatch: { activeTools: { toolu_1: { toolName: "Bash", startedAt: 5_000, backgroundedAt: 15_000 } } } })
    const action = post(postEvent(), core)
    assertEquals(effectsOfType(action, "cold_append")[0].entry.backgrounded, true)
})

Deno.test("hook-post: a hidden tool still clears its activeTools entry", () => {
    const core = topicCore({ sessionPatch: { activeTools: { toolu_1: { toolName: "x", startedAt: 5_000 } } } })
    const action = post(postEvent({ toolName: "mcp__plugin_telegram_telegram__reply" }), core)
    const patch = get(action, "stateChanges.chatSessions.sess-1.activeTools")
    assert("toolu_1" in patch && patch.toolu_1 === undefined)
})

Deno.test("hook-stop: clears every in-flight tool", () => {
    const core = topicCore({ sessionPatch: { activeTools: { toolu_1: { toolName: "Bash", startedAt: 5_000 } } } })
    const action = stop({ type: "claude_hook_stop", ts: 6_000, sessionId: "sess-1", claudePid: 1234 }, core)
    const patch = get(action, "stateChanges.chatSessions.sess-1")
    assert("activeTools" in patch && patch.activeTools === undefined)
})

Deno.test("activeTools does not survive a daemon restart", () => {
    assert(SESSION_FIELDS_RESET_ON_RESTART.includes("activeTools"))
})

// ── slow-tool-check ──────────────────────────────────────────────────

Deno.test("slow-tool-check: a call that already finished does nothing", () => {
    const core = topicCore()
    const action = slowToolCheck(checkEvent(), core)
    assertEquals(action.effects, [])
})

Deno.test("slow-tool-check: a call still running is backgrounded once", () => {
    const core = topicCore({ sessionPatch: { activeTools: { toolu_1: { toolName: "Bash", startedAt: 5_000 } } } })
    const action = slowToolCheck(checkEvent(), core)
    const effects = effectsOfType(action, "run_tool_in_background")
    assertEquals(effects, [{ type: "run_tool_in_background", sessionId: "sess-1", toolUseId: "toolu_1", toolName: "Bash" }])
    assertEquals(get(action, "stateChanges.chatSessions.sess-1.activeTools.toolu_1.backgroundedAt"), 15_000)

    // Second firing (e.g. a re-armed timer) must not press ctrl+b again.
    const again = topicCore({ sessionPatch: { activeTools: { toolu_1: { toolName: "Bash", startedAt: 5_000, backgroundedAt: 15_000 } } } })
    assertEquals(slowToolCheck(checkEvent(), again).effects, [])
})

Deno.test("slow-tool-check: honours /auto_background off at fire time", () => {
    const core = topicCore({
        chatState: { autoBackground: { [KEY]: { enabled: false } } },
        sessionPatch: { activeTools: { toolu_1: { toolName: "Bash", startedAt: 5_000 } } },
    })
    assertEquals(slowToolCheck(checkEvent(), core).effects, [])
})

Deno.test("slow-tool-check: a backend without backgroundTools is left alone", () => {
    const core = topicCore({ sessionPatch: { backend: "local", activeTools: { toolu_1: { toolName: "bash", startedAt: 5_000 } } } })
    assertEquals(slowToolCheck(checkEvent(), core).effects, [])
})

Deno.test("slow-tool-check: unknown session or missing ids are no-ops", () => {
    assertEquals(slowToolCheck(checkEvent({ sessionId: "ghost" }), topicCore()).effects, [])
    assertEquals(slowToolCheck(checkEvent({ toolUseId: null }), topicCore()).effects, [])
})

// ── stall-check ──────────────────────────────────────────────────────

Deno.test("stall-check: a frozen screen with a tool in flight is busy, not stalled", () => {
    const record = [
        { hash: "aa", ts: 0 },
        { hash: "aa", ts: 30_000 },
        { hash: "aa", ts: 60_000 },
        { hash: "aa", ts: 90_000 },
    ]
    const core = topicCore({
        sessionPatch: { status: "working", agentRequest: 7, screenBufferRecord: record, activeTools: { toolu_1: { toolName: "Bash", startedAt: 0 } } },
    })
    const action = stallCheck({ type: "stall_check", ts: 120_000, sessionId: "sess-1", forAgentRequest: 7 }, core)
    assertEquals(action.followUpEvents ?? [], [])
    assertEquals(get(action, "stateChanges.chatSessions.sess-1.status"), undefined)
    const timers = effectsOfType(action, "set_timer")
    assertEquals(timers.length, 1)
    assertEquals(timers[0].event.type, "stall_check")

    // Same screen, no tool in flight → the existing stall path still fires.
    const idle = topicCore({ sessionPatch: { status: "working", agentRequest: 7, screenBufferRecord: record } })
    const stalled = stallCheck({ type: "stall_check", ts: 120_000, sessionId: "sess-1", forAgentRequest: 7 }, idle)
    assertEquals(stalled.followUpEvents?.[0]?.type, "claude_hook_stop")
})

// ── /auto_background ─────────────────────────────────────────────────

function cmdEvent(text) {
    return {
        type: "chat_user_message", ts: 1, chatId: "42", userId: "42", username: "alice",
        messageId: 7, text, chatType: "private", threadId: null,
    }
}

Deno.test("/auto_background off|on|30 stores per-topic overrides; bare shows the setting", () => {
    const run = autoBackgroundCommands.auto_background
    const core = makeCore({ chatState: {} })

    const off = run(cmdEvent("/auto_background off"), core)
    assertEquals(get(off, "stateChanges.chatState.autoBackground.42:"), { enabled: false })
    assert(effectsOfType(off, "send_text_to_user")[0].text.includes("*off*"))

    const thirty = run(cmdEvent("/auto_background 30"), core)
    assertEquals(get(thirty, "stateChanges.chatState.autoBackground.42:"), { thresholdMs: 30_000 })
    assert(effectsOfType(thirty, "send_text_to_user")[0].text.includes("30s"))

    const on = run(cmdEvent("/auto_background on"), core)
    const patch = get(on, "stateChanges.chatState.autoBackground")
    assert("42:" in patch && patch["42:"] === undefined)

    const shown = run(cmdEvent("/auto_background"), makeCore({ chatState: { autoBackground: { "42:": { enabled: false } } } }))
    assertEquals(shown.stateChanges, undefined)
    assert(effectsOfType(shown, "send_text_to_user")[0].text.includes("*off*"))

    const bad = run(cmdEvent("/auto_background soon"), core)
    assert(effectsOfType(bad, "send_text_to_user")[0].text.startsWith("Usage:"))
})

// ── Claude backend ───────────────────────────────────────────────────

Deno.test("claude backend: runInBackground only applies to Bash, and needs a socket", async () => {
    assertEquals(claudeBackend.capabilities.backgroundTools, true)
    const read = await claudeBackend.runInBackground({ session: session("s"), toolName: "Read" })
    assertEquals(read.ok, false)
    assert(read.detail.includes("Bash"))
    const noSocket = await claudeBackend.runInBackground({ session: { id: "s" }, toolName: "Bash" })
    assertEquals(noSocket.ok, false)
})
