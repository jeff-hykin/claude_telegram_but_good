// tests/handler-telegram-user-test.js
//
// Unit tests for lib/event-handlers/telegram-user.js. Focuses on:
//   - allowlist gating (drops non-allowlisted senders silently)
//   - /approve_user bypass (always reaches hot-command dispatch)
//   - plain-text routing to the focused session (+ spinner effect,
//     cold-append, deliver_channel_event, message recording)
//   - reply-to routing via state lookup vs. legacy header fallback
//   - no-focused-session queueing path
//   - /switch_<id> dispatch
//   - long task creation dispatch

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, writeAccess, makeCore, effectsOfType, get } from "./_helpers.js"

// paths MUST be redirected before the handler's access.js dependency
// resolves its file read. Do that once for the whole file.
const { paths: tmpPaths } = setupTempPaths("cbg-tg-user-test-")
writeAccess(["42"])

const mod = await import("../lib/event-handlers/telegram-user.js")
const handle = mod.default

function baseEvent(overrides = {}) {
    return {
        type: "telegram_user_message",
        ts: 1_000_000,
        chatId: "42",
        userId: "42",
        username: "alice",
        messageId: 101,
        text: "hello world",
        replyToMessageId: null,
        replyToText: null,
        attachment: null,
        chatType: "private",
        ...overrides,
    }
}

Deno.test("telegram-user: drops messages from non-allowlisted users", () => {
    const core = makeCore({
        chatState: { focusedSessionId: "sess-1" },
        chatSessions: { "sess-1": { id: "sess-1", _conn: {} } },
    })
    const action = handle(baseEvent({ userId: "999" }), core)
    assertEquals(action.effects, [])
    assertEquals(action.stateChanges, {})
})

Deno.test("telegram-user: empty text is a no-op", () => {
    const core = makeCore()
    const action = handle(baseEvent({ text: "" }), core)
    assertEquals(action.effects, [])
    assertEquals(action.stateChanges, {})
})

Deno.test("telegram-user: /approve_user bypasses the allowlist and routes as hot command", () => {
    const core = makeCore({ chatState: {} })
    const action = handle(baseEvent({ userId: "999", text: "/approve_user abc123" }), core)
    const hot = effectsOfType(action, "run_hot_command")
    assertEquals(hot.length, 1)
    assertEquals(hot[0].name, "approve_user")
})

Deno.test("telegram-user: plain text to focused session emits spinner + deliver + cold_append", () => {
    const conn = {}
    const core = makeCore({
        chatState: { focusedSessionId: "sess-1" },
        chatSessions: { "sess-1": { id: "sess-1", _conn: conn } },
    })
    const action = handle(baseEvent(), core)

    const spinners = effectsOfType(action, "start_session_spinner")
    assertEquals(spinners.length, 1)
    assertEquals(spinners[0].sessionId, "sess-1")
    assertEquals(spinners[0].chatId, "42")
    assert(typeof spinners[0].headerHtml === "string" && spinners[0].headerHtml.includes("processing"))

    const delivers = effectsOfType(action, "deliver_channel_event")
    assertEquals(delivers.length, 1)
    assertEquals(delivers[0].sessionId, "sess-1")
    assertEquals(delivers[0].content, "hello world")
    assertEquals(delivers[0].meta.chat_id, "42")
    assertEquals(delivers[0].meta.message_id, "101")

    const cold = effectsOfType(action, "cold_append")
    assertEquals(cold.length, 1)
    assertEquals(cold[0].stream, "messages")
    assertEquals(cold[0].entry.from, "user")
    assertEquals(cold[0].entry.sessionId, "sess-1")
})

Deno.test("telegram-user: records inbound message in specialData.telegramMessagesByChatId", () => {
    const core = makeCore({
        chatState: { focusedSessionId: "sess-1" },
        chatSessions: { "sess-1": { id: "sess-1", _conn: {} } },
    })
    const action = handle(baseEvent(), core)
    const patch = get(action, "stateChanges.specialData.telegramMessagesByChatId.42.101")
    assertEquals(patch.from, "user")
    assertEquals(patch.kind, "regular")
    assertEquals(patch.text, "hello world")
    assertEquals(patch.userId, "42")
    assertEquals(patch.replyToMessageId, null)
})

Deno.test("telegram-user: records lastInbound + clears nudgedForInbound on the target session", () => {
    const core = makeCore({
        chatState: { focusedSessionId: "sess-1" },
        chatSessions: { "sess-1": { id: "sess-1", _conn: {}, nudgedForInbound: true } },
    })
    const action = handle(baseEvent(), core)
    const patch = get(action, "stateChanges.chatSessions.sess-1")
    assertEquals(patch.lastInbound.messageId, "101")
    assertEquals(patch.lastInbound.text, "hello world")
    assertEquals(patch.nudgedForInbound, false)
})

Deno.test("telegram-user: reply-to lookup via state overrides focus", () => {
    const core = makeCore({
        chatState: { focusedSessionId: "sess-focused" },
        chatSessions: {
            "sess-focused": { id: "sess-focused", _conn: {} },
            "sess-other": { id: "sess-other", _conn: {} },
        },
        specialData: {
            telegramMessagesByChatId: {
                "42": {
                    "88": {
                        id: "88", chatId: "42", from: "agent",
                        kind: "regular", ts: 1, sessionId: "sess-other", text: "prev",
                    },
                },
            },
        },
    })
    const action = handle(baseEvent({ replyToMessageId: 88 }), core)
    const delivers = effectsOfType(action, "deliver_channel_event")
    assertEquals(delivers.length, 1)
    assertEquals(delivers[0].sessionId, "sess-other")
})

Deno.test("telegram-user: reply-to header fallback works when state lookup misses", () => {
    const core = makeCore({
        chatState: { focusedSessionId: "sess-focused" },
        chatSessions: {
            "sess-focused": { id: "sess-focused", _conn: {} },
            "legacyId": { id: "legacyId", _conn: {} },
        },
    })
    const action = handle(
        baseEvent({ replyToMessageId: 99, replyToText: "/chat_legacyId\nhi" }),
        core,
    )
    const delivers = effectsOfType(action, "deliver_channel_event")
    assertEquals(delivers[0].sessionId, "legacyId")
})

Deno.test("telegram-user: queues message when no focused session is available", () => {
    const core = makeCore({ chatState: {} })
    const action = handle(baseEvent(), core)
    const queue = get(action, "stateChanges.chatState.messageQueue")
    assertEquals(queue.length, 1)
    assertEquals(queue[0].content, "hello world")
    assertEquals(effectsOfType(action, "deliver_channel_event").length, 0)
    assertEquals(effectsOfType(action, "send_text_to_user").length, 1)
})

Deno.test("telegram-user: /switch_<id> updates focus", () => {
    const core = makeCore({
        chatState: { focusedSessionId: "sess_a" },
        chatSessions: {
            "sess_a": { id: "sess_a", _conn: {} },
            "sess_b": { id: "sess_b", _conn: {}, title: "B" },
        },
    })
    const action = handle(baseEvent({ text: "/switch_sess_b", messageId: 102 }), core)
    assertEquals(get(action, "stateChanges.chatState.focusedSessionId"), "sess_b")
})

Deno.test("telegram-user: /switch_<id> reports not-found when target missing", () => {
    const core = makeCore({ chatState: { focusedSessionId: null } })
    const action = handle(baseEvent({ text: "/switch_ghost" }), core)
    const msgs = effectsOfType(action, "send_text_to_user")
    assertEquals(msgs.length, 1)
    assert(msgs[0].text.includes("not found"))
})

Deno.test("telegram-user: /task <description> creates a long task + notifies worker", () => {
    const core = makeCore({
        chatState: { focusedSessionId: "worker" },
        chatSessions: { "worker": { id: "worker", _conn: {} } },
    })
    const action = handle(baseEvent({ text: "/task write a readme" }), core)
    const tasks = get(action, "stateChanges.specialData.longTaskByChatId.42")
    const taskIds = Object.keys(tasks)
    assertEquals(taskIds.length, 1)
    const task = tasks[taskIds[0]]
    assertEquals(task.state, "defining")
    assertEquals(task.workerSessionId, "worker")
    assertEquals(task.originalPrompt, "write a readme")
    const delivers = effectsOfType(action, "deliver_channel_event")
    assertEquals(delivers.length, 1)
    assertEquals(delivers[0].sessionId, "worker")
})

Deno.test("telegram-user: session with no _conn is reported as disconnected", () => {
    const core = makeCore({
        chatState: { focusedSessionId: "sess-1" },
        chatSessions: { "sess-1": { id: "sess-1" } },
    })
    const action = handle(baseEvent(), core)
    const msgs = effectsOfType(action, "send_text_to_user")
    assertEquals(msgs.length, 1)
    assert(msgs[0].text.includes("no active connection"))
})

Deno.test("telegram-user: /task prompt points the worker at paths.longTaskDir, not $HOME/.cbg", () => {
    const core = makeCore({
        chatState: { focusedSessionId: "worker" },
        chatSessions: { "worker": { id: "worker", _conn: {} } },
    })
    const action = handle(baseEvent({ text: "/task write a readme" }), core)
    const delivers = effectsOfType(action, "deliver_channel_event")
    assertEquals(delivers.length, 1)
    const prompt = delivers[0].content
    // The prompt must reference the real temp paths.LONG_TASKS_DIR we
    // redirected setupTempPaths at — not the stale $HOME/.cbg literal.
    assert(
        prompt.includes(tmpPaths.LONG_TASKS_DIR),
        `prompt missing real long-tasks dir: ${prompt.slice(0, 400)}`,
    )
    assert(
        !prompt.includes("$HOME/.cbg/"),
        `prompt still contains stale $HOME/.cbg path: ${prompt.slice(0, 400)}`,
    )
    // And each of context/progress/report is named.
    assert(prompt.includes("/context.md"))
    assert(prompt.includes("/progress.md"))
    assert(prompt.includes("/report.md"))
})

Deno.test("telegram-user: /task_cancel_<id> DELETES the task entry from longTaskByChatId", () => {
    const core = makeCore({
        chatState: { focusedSessionId: "worker" },
        chatSessions: { "worker": { id: "worker", _conn: {} } },
        specialData: {
            longTaskByChatId: {
                "42": {
                    "t1": {
                        id: "t1", title: "old task", state: "in_progress",
                        workerSessionId: "worker", definition: "x",
                    },
                },
            },
        },
    })
    const action = handle(baseEvent({ text: "/task_cancel_t1" }), core)
    // mergeSessionData undefined → delete: the patch value is undefined
    // AND the key is present on the patch (not just missing).
    const patch = action.stateChanges.specialData.longTaskByChatId["42"]
    assertEquals(patch.t1, undefined)
    assert("t1" in patch, "cancel patch must carry an explicit undefined delete sentinel")
    // A cold-storage entry goes out for history and a deliver_channel_event
    // informs the worker.
    assertEquals(effectsOfType(action, "cold_append")[0].entry.event, "cancelled")
    assertEquals(effectsOfType(action, "deliver_channel_event").length, 1)
})
