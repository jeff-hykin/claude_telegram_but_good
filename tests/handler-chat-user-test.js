// tests/handler-chat-user-test.js
//
// Unit tests for lib/event-handlers/chat-user.js. Focuses on:
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

const mod = await import("../lib/event-handlers/chat-user.js")
const handle = mod.default

// Load the real commands/*.js registry so /approve_user etc. resolve.
// Uses the absolute path to the repo's commands dir computed from this
// test file's location.
const hotCommandsMod = await import("../lib/hot-commands.js")
const commandsDir = new URL("../commands", import.meta.url).pathname
await hotCommandsMod.loadCommands(commandsDir)

function baseEvent(overrides = {}) {
    return {
        type: "chat_user_message",
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

Deno.test("chat-user: drops plain text from non-allowlisted users", async () => {
    const core = makeCore({
        chatState: { focusedSessionId: "sess-1" },
        chatSessions: { "sess-1": { id: "sess-1", _conn: {} } },
    })
    const action = await handle(baseEvent({ userId: "999" }), core)
    assertEquals(action.effects, [])
    assertEquals(action.stateChanges, {})
})

Deno.test("chat-user: empty text is a no-op", async () => {
    const core = makeCore()
    const action = await handle(baseEvent({ text: "" }), core)
    assertEquals(action.effects, [])
    assertEquals(action.stateChanges, {})
})

Deno.test("chat-user: slash commands bypass the allowlist gate (plain text alone is gated)", async () => {
    // `/approve_user` is the paradigm case: an unallowlisted user
    // needs to reach it to pair. The new dispatcher only gates PLAIN
    // TEXT; slash commands always route into the hot-command registry
    // and each command self-gates. approve_user itself replies with a
    // usage hint for a malformed token — the test just needs proof
    // that the handler didn't silently drop the message.
    const core = makeCore({ chatState: {} })
    const action = await handle(
        baseEvent({ userId: "999", text: "/approve_user abc123" }),
        core,
    )
    const sends = effectsOfType(action, "send_text_to_user")
    assert(sends.length >= 1, "expected at least one reply from the command")
})

Deno.test("chat-user: plain text to focused session emits deliver + cold_append", async () => {
    // Post-Phase-B: the handler no longer emits a start_session_spinner
    // effect — onEvent's built-in spinner policy starts the spinner
    // when it observes a deliver_channel_event on this event type.
    // See lib/spinner.js.
    const conn = {}
    const core = makeCore({
        chatState: { focusedSessionId: "sess-1" },
        chatSessions: { "sess-1": { id: "sess-1", _conn: conn } },
    })
    const action = await handle(baseEvent(), core)

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

    // The action itself should NOT contain any spinner effects — those
    // effect types were removed in Phase B.
    assertEquals(effectsOfType(action, "start_session_spinner").length, 0)
})

Deno.test("chat-user: records inbound message in specialData.telegramMessagesByChatId", async () => {
    const core = makeCore({
        chatState: { focusedSessionId: "sess-1" },
        chatSessions: { "sess-1": { id: "sess-1", _conn: {} } },
    })
    const action = await handle(baseEvent(), core)
    const patch = get(action, "stateChanges.specialData.telegramMessagesByChatId.42.101")
    assertEquals(patch.from, "user")
    assertEquals(patch.kind, "regular")
    assertEquals(patch.text, "hello world")
    assertEquals(patch.userId, "42")
    assertEquals(patch.replyToMessageId, null)
})

Deno.test("chat-user: records lastInbound + activates waiting state on the target session", async () => {
    const core = makeCore({
        chatState: { focusedSessionId: "sess-1" },
        chatSessions: { "sess-1": { id: "sess-1", _conn: {}, status: "idle" } },
    })
    const action = await handle(baseEvent(), core)
    const patch = get(action, "stateChanges.chatSessions.sess-1")
    assertEquals(patch.lastInbound.messageId, "101")
    assertEquals(patch.lastInbound.text, "hello world")
    // New-request activation: status flips to "working", agentRequest
    // increments from 0 to 1, pendingNudgeAction set for the reply-tool
    // watchdog.
    assertEquals(patch.status, "working")
    assertEquals(patch.agentRequest, 1)
    assertEquals(patch.pendingNudgeAction, "askAgentToSendChatMessage")
})

Deno.test("chat-user: does NOT bump agentRequest when session is already working AND pendingNudgeAction is still set", async () => {
    const core = makeCore({
        chatState: { focusedSessionId: "sess-1" },
        chatSessions: {
            "sess-1": {
                id: "sess-1",
                _conn: {},
                status: "working",
                agentRequest: 5,
                pendingNudgeAction: "askAgentToSendChatMessage",
            },
        },
    })
    const action = await handle(baseEvent(), core)
    const patch = get(action, "stateChanges.chatSessions.sess-1")
    // activateWaitingState is a no-op for working sessions with a
    // still-pending nudge — activation fields are absent from the patch
    // so the existing epoch and stall_check stay in flight.
    assertEquals(patch.lastInbound.text, "hello world")
    assertEquals(patch.status, undefined)
    assertEquals(patch.agentRequest, undefined)
    assertEquals(patch.pendingNudgeAction, undefined)
})

Deno.test("chat-user: mid-turn inbound REFRESHES pendingNudgeAction when agent already answered prior inbound", async () => {
    // Walkthrough:
    //   - Session is working (e.g., the agent is mid-turn after replying to msg 1).
    //   - handleReply cleared pendingNudgeAction to "none".
    //   - User sends msg 2.
    //   - Without this refresh, the next Stop would see pendingNudgeAction
    //     = none and silently drop msg 2 from the nudge watchdog.
    const core = makeCore({
        chatState: { focusedSessionId: "sess-1" },
        chatSessions: {
            "sess-1": {
                id: "sess-1",
                _conn: {},
                status: "working",
                agentRequest: 5,
                pendingNudgeAction: "none",
            },
        },
    })
    const action = await handle(baseEvent(), core)
    const patch = get(action, "stateChanges.chatSessions.sess-1")
    // lastInbound still updates.
    assertEquals(patch.lastInbound.text, "hello world")
    // agentRequest unchanged — no new epoch.
    assertEquals(patch.agentRequest, undefined)
    assertEquals(patch.status, undefined)
    // pendingNudgeAction is refreshed back to the reply-nudge action.
    assertEquals(patch.pendingNudgeAction, "askAgentToSendChatMessage")
    // No new stall_check — the existing one from epoch 5 is still in flight.
    assertEquals(effectsOfType(action, "set_timer").length, 0)
})

Deno.test("chat-user: mid-turn inbound on a long-task session refreshes to taskCheck", async () => {
    // Same as above but the session owns a long task — the refreshed
    // action must be "taskCheck", not "askAgentToSendChatMessage", so
    // long-task priority is preserved.
    const core = makeCore({
        chatState: { focusedSessionId: "sess-1" },
        chatSessions: {
            "sess-1": {
                id: "sess-1",
                _conn: {},
                status: "working",
                agentRequest: 5,
                pendingNudgeAction: "none",
                longTaskId: "TaskAbc123",
            },
        },
    })
    const action = await handle(baseEvent(), core)
    const patch = get(action, "stateChanges.chatSessions.sess-1")
    assertEquals(patch.pendingNudgeAction, "taskCheck")
    assertEquals(patch.agentRequest, undefined)
    assertEquals(effectsOfType(action, "set_timer").length, 0)
})

Deno.test("chat-user: reply-to lookup via state overrides focus", async () => {
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
    const action = await handle(baseEvent({ replyToMessageId: 88 }), core)
    const delivers = effectsOfType(action, "deliver_channel_event")
    assertEquals(delivers.length, 1)
    assertEquals(delivers[0].sessionId, "sess-other")
})

Deno.test("chat-user: reply-to header fallback works when state lookup misses", async () => {
    const core = makeCore({
        chatState: { focusedSessionId: "sess-focused" },
        chatSessions: {
            "sess-focused": { id: "sess-focused", _conn: {} },
            "legacyId": { id: "legacyId", _conn: {} },
        },
    })
    const action = await handle(
        baseEvent({ replyToMessageId: 99, replyToText: "/chat_legacyId\nhi" }),
        core,
    )
    const delivers = effectsOfType(action, "deliver_channel_event")
    assertEquals(delivers[0].sessionId, "legacyId")
})

Deno.test("chat-user: queues message when no focused session is available", async () => {
    const core = makeCore({ chatState: {} })
    const action = await handle(baseEvent(), core)
    const queue = get(action, "stateChanges.chatState.messageQueue")
    assertEquals(queue.length, 1)
    assertEquals(queue[0].content, "hello world")
    assertEquals(effectsOfType(action, "deliver_channel_event").length, 0)
    assertEquals(effectsOfType(action, "send_text_to_user").length, 1)
})

Deno.test("chat-user: /switch_<id> updates focus", async () => {
    const core = makeCore({
        chatState: { focusedSessionId: "sess_a" },
        chatSessions: {
            "sess_a": { id: "sess_a", _conn: {} },
            "sess_b": { id: "sess_b", _conn: {}, title: "B" },
        },
    })
    const action = await handle(baseEvent({ text: "/switch_sess_b", messageId: 102 }), core)
    assertEquals(get(action, "stateChanges.chatState.focusedSessionId"), "sess_b")
})

Deno.test("chat-user: /switch_<id> reports not-found when target missing", async () => {
    const core = makeCore({ chatState: { focusedSessionId: null } })
    const action = await handle(baseEvent({ text: "/switch_ghost" }), core)
    const msgs = effectsOfType(action, "send_text_to_user")
    assertEquals(msgs.length, 1)
    assert(msgs[0].text.includes("not found"))
})

Deno.test("chat-user: /task <description> creates a long task + notifies worker", async () => {
    const core = makeCore({
        chatState: { focusedSessionId: "worker" },
        chatSessions: { "worker": { id: "worker", _conn: {} } },
    })
    const action = await handle(baseEvent({ text: "/task write a readme" }), core)
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

Deno.test("chat-user: /task rejects if the focused session already has a live task", async () => {
    // Session.longTaskId points at an existing live task in specialData →
    // the new /task should be rejected and the user shown the edit/cancel
    // command links.
    const core = makeCore({
        chatState: { focusedSessionId: "worker" },
        chatSessions: {
            "worker": { id: "worker", _conn: {}, longTaskId: "Existing0001" },
        },
        specialData: {
            longTaskByChatId: {
                "42": {
                    "Existing0001": {
                        id: "Existing0001", title: "earlier task",
                        state: "in_progress", workerSessionId: "worker",
                        definition: "stub",
                    },
                },
            },
        },
    })
    const action = await handle(baseEvent({ text: "/task write a readme" }), core)

    // No new task was created.
    const tasks = get(action, "stateChanges.specialData.longTaskByChatId.42") ?? {}
    assertEquals(Object.keys(tasks).length, 0, "no new task should have been written")
    // No deliver_channel_event (the worker wasn't told to start a new task).
    assertEquals(effectsOfType(action, "deliver_channel_event").length, 0)
    // The user got a single reply with the edit/cancel links.
    const msgs = effectsOfType(action, "send_text_to_user")
    assertEquals(msgs.length, 1)
    assert(msgs[0].text.includes("Existing0001"), "rejection should name the existing task")
    assert(msgs[0].text.includes("already has an active task"))
    assert(msgs[0].text.includes("/task_view_Existing0001"))
    assert(msgs[0].text.includes("/task_update_Existing0001"))
    assert(msgs[0].text.includes("/task_cancel_Existing0001"))
})

Deno.test("chat-user: /task allows creation when session.longTaskId is set but the task is missing from specialData (stale pointer)", async () => {
    // Dangling pointer: session says it owns task X but X isn't in
    // specialData (bug, race, manual edit). Should fall through and
    // create the new task; the new task's state patch overwrites the
    // stale pointer.
    const core = makeCore({
        chatState: { focusedSessionId: "worker" },
        chatSessions: {
            "worker": { id: "worker", _conn: {}, longTaskId: "GhostTask" },
        },
        specialData: { longTaskByChatId: { "42": {} } },
    })
    const action = await handle(baseEvent({ text: "/task write a readme" }), core)

    // New task WAS created.
    const tasks = get(action, "stateChanges.specialData.longTaskByChatId.42")
    const taskIds = Object.keys(tasks)
    assertEquals(taskIds.length, 1)
    assert(taskIds[0] !== "GhostTask", "new id must differ from the stale pointer")
    // The session patch sets longTaskId to the NEW task (overwriting GhostTask).
    const sessionPatch = get(action, "stateChanges.chatSessions.worker")
    assertEquals(sessionPatch.longTaskId, taskIds[0])
})

Deno.test("chat-user: session with no _conn is reported as disconnected", async () => {
    const core = makeCore({
        chatState: { focusedSessionId: "sess-1" },
        chatSessions: { "sess-1": { id: "sess-1" } },
    })
    const action = await handle(baseEvent(), core)
    const msgs = effectsOfType(action, "send_text_to_user")
    assertEquals(msgs.length, 1)
    assert(msgs[0].text.includes("no active connection"))
})

Deno.test("chat-user: /task prompt points the worker at paths.longTaskDir, not $HOME/.cbg", async () => {
    const core = makeCore({
        chatState: { focusedSessionId: "worker" },
        chatSessions: { "worker": { id: "worker", _conn: {} } },
    })
    const action = await handle(baseEvent({ text: "/task write a readme" }), core)
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

Deno.test("chat-user: /task_cancel_<id> DELETES the task entry from longTaskByChatId", async () => {
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
    const action = await handle(baseEvent({ text: "/task_cancel_t1" }), core)
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
