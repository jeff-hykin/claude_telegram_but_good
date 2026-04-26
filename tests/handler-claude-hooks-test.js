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
import { setupTempPaths, makeCore, effectsOfType, get, paths } from "./_helpers.js"

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

Deno.test("hook-pre: focused session emits cold_append + lastActive (spinner handled by policy)", () => {
    // Post-Phase-B: the handler no longer emits append_tool_to_spinner
    // — onEvent's spinner policy picks up the event independently and
    // appends via lib/spinner.js. The handler's job is now just
    // cold-storage + lastActive + the "formatter returned null"
    // hide-tool gate.
    const core = makeCore({
        chatState: { focusedSessionId: "sess-1" },
        chatSessions: { "sess-1": session("sess-1") },
    })
    const action = pre(preEvent(), core)
    assertEquals(effectsOfType(action, "append_tool_to_spinner").length, 0)
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

Deno.test("hook-post: focused session emits cold_append (spinner handled by policy)", () => {
    const core = makeCore({
        chatState: { focusedSessionId: "sess-1" },
        chatSessions: { "sess-1": session("sess-1") },
    })
    const action = post(postEvent({ outputPreview: "\"ok\"" }), core)
    assertEquals(effectsOfType(action, "append_tool_to_spinner").length, 0)
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

Deno.test("hook-stop: records lastStopAt + status=idle + cold_append on a clean session", () => {
    const core = makeCore({
        chatSessions: { "sess-1": session("sess-1") },
    })
    const action = stop(stopEvent(), core)
    assertEquals(get(action, "stateChanges.chatSessions.sess-1.lastStopAt"), 6_000)
    assertEquals(get(action, "stateChanges.chatSessions.sess-1.lastActive"), 6_000)
    assertEquals(get(action, "stateChanges.chatSessions.sess-1.status"), "idle")
    assertEquals(effectsOfType(action, "cold_append").length, 1)
    assertEquals(effectsOfType(action, "send_text_to_claude").length, 0)
})

Deno.test("hook-stop: fires reply-nudge when pendingNudgeAction=askAgentToSendChatMessage", () => {
    const core = makeCore({
        chatSessions: {
            "sess-1": session("sess-1", {
                pendingNudgeAction: "askAgentToSendChatMessage",
            }),
        },
    })
    const action = stop(stopEvent({ ts: 100_000 }), core)
    // Now schedules a delayed timer instead of nudging immediately.
    const timers = effectsOfType(action, "set_timer")
    assert(timers.length >= 1)
    const nudgeTimer = timers.find(t => t.event?.type === "stop_nudge_fire" && t.event?.nudgeType === "reply")
    assert(nudgeTimer, "should schedule a reply nudge timer")
    // pendingNudgeAction stays set — cleared when the timer fires or agent replies.
})

Deno.test("hook-stop: does NOT nudge when pendingNudgeAction=none", () => {
    const core = makeCore({
        chatSessions: {
            "sess-1": session("sess-1", { pendingNudgeAction: "none" }),
        },
    })
    const action = stop(stopEvent({ ts: 100_000 }), core)
    assertEquals(effectsOfType(action, "send_text_to_claude").length, 0)
})

Deno.test("hook-stop: does NOT nudge twice — second Stop sees pendingNudgeAction=none", () => {
    // Emulating the state after a prior Stop already fired the nudge:
    // the handler cleared pendingNudgeAction to "none", so a fresh Stop
    // must NOT fire again.
    const core = makeCore({
        chatSessions: {
            "sess-1": session("sess-1", { pendingNudgeAction: "none" }),
        },
    })
    const action = stop(stopEvent({ ts: 100_000 }), core)
    assertEquals(effectsOfType(action, "send_text_to_claude").length, 0)
})

Deno.test("hook-stop: taskCheck with existing report.md spawns critic", () => {
    // Write a fake report.md under a fake task dir so reportMdExists() sees it.
    // Use the _helpers.js `paths` export — it's the SAME singleton the
    // handler reads via versionedImport, because setupTempPaths() mutates
    // that singleton in place. A bare `import("../lib/paths.js")` would
    // produce a second module instance pointing at the real $CBG_DIR.
    const taskId = "TaskDemo0001"
    const dir = paths.longTaskDir(taskId)
    Deno.mkdirSync(dir, { recursive: true })
    Deno.writeTextFileSync(`${dir}/report.md`, "# done\n")

    const core = makeCore({
        chatSessions: {
            "sess-1": session("sess-1", {
                longTaskId: taskId,
                pendingNudgeAction: "taskCheck",
            }),
        },
        specialData: {
            longTaskByChatId: {
                "42": {
                    [taskId]: {
                        id: taskId,
                        state: "in_progress",
                        workerSessionId: "sess-1",
                        definition: "stub",
                        criticCallCount: 0,
                    },
                },
            },
        },
    })
    const action = stop(stopEvent({ ts: 100_000 }), core)
    const spawns = effectsOfType(action, "spawn_critic")
    assertEquals(spawns.length, 1)
    assertEquals(spawns[0].taskId, taskId)
    // Critic spawned → pendingNudgeAction cleared (next state driven by verdict).
    assertEquals(get(action, "stateChanges.chatSessions.sess-1.pendingNudgeAction"), "none")
    // criticCallCount incremented.
    assertEquals(
        get(action, `stateChanges.specialData.longTaskByChatId.42.${taskId}.criticCallCount`),
        1,
    )

    // Cleanup.
    try { Deno.removeSync(`${dir}/report.md`) } catch { /* ignore */ }
    try { Deno.removeSync(dir) } catch { /* ignore */ }
})

Deno.test("hook-stop: taskCheck without report.md schedules delayed nudge timer", () => {
    const taskId = "TaskDemo0002"
    const core = makeCore({
        chatSessions: {
            "sess-1": session("sess-1", {
                longTaskId: taskId,
                pendingNudgeAction: "taskCheck",
            }),
        },
        specialData: {
            longTaskByChatId: {
                "42": {
                    [taskId]: {
                        id: taskId,
                        state: "in_progress",
                        workerSessionId: "sess-1",
                        definition: "stub",
                        consecutiveIdleStops: 0,
                    },
                },
            },
        },
    })
    const action = stop(stopEvent({ ts: 100_000 }), core)
    // Schedules a delayed timer, not an immediate nudge.
    const timers = effectsOfType(action, "set_timer")
    const taskTimer = timers.find(t => t.event?.type === "stop_nudge_fire" && t.event?.nudgeType === "taskReport")
    assert(taskTimer, "should schedule a task report nudge timer")
    assertEquals(taskTimer.event.taskId, taskId)
})

Deno.test("hook-stop: taskCheck without report.md on a SYNTHETIC Stop schedules nudge timer", () => {
    const taskId = "TaskDemo0003"
    const core = makeCore({
        chatSessions: {
            "sess-1": session("sess-1", {
                longTaskId: taskId,
                pendingNudgeAction: "taskCheck",
            }),
        },
        specialData: {
            longTaskByChatId: {
                "42": {
                    [taskId]: {
                        id: taskId,
                        state: "in_progress",
                        workerSessionId: "sess-1",
                        definition: "stub",
                        consecutiveIdleStops: 0,
                        totalNudges: 0,
                    },
                },
            },
        },
    })
    // Synthetic stops also schedule a timer (same as real stops now).
    const action = stop({ ...stopEvent({ ts: 100_000 }), synthetic: true }, core)
    const timers = effectsOfType(action, "set_timer")
    const taskTimer = timers.find(t => t.event?.type === "stop_nudge_fire" && t.event?.nudgeType === "taskReport")
    assert(taskTimer, "should schedule a task report nudge timer")
})

// ── pendingQueue drain on Stop ──────────────────────────────────────

Deno.test("hook-stop: drains pendingQueue and delivers exactly one entry, leaving the rest", () => {
    const core = makeCore({
        chatState: { focusedSessionId: "sess-1" },
        chatSessions: {
            "sess-1": session("sess-1", {
                pendingQueue: [
                    { text: "first",  chatId: "100", messageId: "m1", queuedAt: 1, _source: "telegram" },
                    { text: "second", chatId: "100", messageId: "m2", queuedAt: 2, _source: "telegram" },
                ],
            }),
        },
    })
    const action = stop(stopEvent(), core)
    const deliver = effectsOfType(action, "deliver_channel_event")
    assertEquals(deliver.length, 1)
    assertEquals(deliver[0].content, "first")
    assertEquals(deliver[0]._queueDrain, true)
    const newQueue = get(action, "stateChanges.chatSessions.sess-1.pendingQueue")
    assertEquals(newQueue.length, 1)
    assertEquals(newQueue[0].text, "second")
})

Deno.test("hook-stop: telegram-sourced queue drain emits Telegram drain notification", () => {
    const core = makeCore({
        chatState: {
            focusedSessionId: "sess-1",
            commandCenter: { chatId: "1000" },
        },
        chatSessions: {
            "sess-1": session("sess-1", {
                pendingQueue: [
                    { text: "from-telegram", chatId: "1000", messageId: "m1", queuedAt: 1, _source: "telegram" },
                ],
                lastInbound: { chatId: "1000" },
            }),
        },
    })
    const action = stop(stopEvent(), core)
    const sends = effectsOfType(action, "send_text_to_user")
    // At least one send_text_to_user describing the queued delivery
    assert(sends.some(s => /Queued message delivered/.test(s.text ?? "")),
        `expected a "Queued message delivered" Telegram message, got: ${sends.map(s => s.text).join(" | ")}`)
})

Deno.test("hook-stop: cli-sourced queue drain skips Telegram drain notification (cbg tell --que regression)", () => {
    const core = makeCore({
        chatState: {
            focusedSessionId: "sess-1",
            commandCenter: { chatId: "1000" },
        },
        chatSessions: {
            "sess-1": session("sess-1", {
                pendingQueue: [
                    { text: "[from CLI]\nfrom-cli", chatId: "cbg-internal", messageId: "cli-1", queuedAt: 1, _source: "cli" },
                ],
                // Even with a stale lastInbound from earlier Telegram traffic,
                // the cli-sourced drain must NOT route to that chat.
                lastInbound: { chatId: "1000" },
            }),
        },
    })
    const action = stop(stopEvent(), core)
    // The deliver_channel_event must still fire so the agent gets the message
    const deliver = effectsOfType(action, "deliver_channel_event")
    assertEquals(deliver.length, 1)
    assertEquals(deliver[0].content, "[from CLI]\nfrom-cli")
    // No "Queued message delivered" Telegram message
    const sends = effectsOfType(action, "send_text_to_user")
    const drainNotifications = sends.filter(s => /Queued message delivered/.test(s.text ?? ""))
    assertEquals(drainNotifications.length, 0,
        `expected NO drain notification for cli-sourced queue, got: ${drainNotifications.map(s => s.text).join(" | ")}`)
})

Deno.test("hook-stop: missing session -> no-op", () => {
    const core = makeCore({ chatSessions: {} })
    const action = stop(stopEvent(), core)
    assertEquals(action.effects, [])
})
