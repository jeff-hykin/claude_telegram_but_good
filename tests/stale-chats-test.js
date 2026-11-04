import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, makeCore, fakeConn, effectsOfType, paths, loadCommands, getHotCommands } from "./_helpers.js"

const { tempDir } = setupTempPaths("cbg-stale-chats-test-")
Deno.writeTextFileSync(paths.ACCESS_FILE, JSON.stringify({ dmPolicy: "pairing", allowFrom: ["42"], groups: {}, pending: {}, commandCenterChatId: "-100222" }))

const { isStaleSession, deliverOrRefresh } = await import("../lib/stale-chats.js")
const staleCheck = (await import("../lib/event-handlers/stale-chat-check.js")).default
const timerFire = (await import("../lib/event-handlers/agent-timer-fire.js")).default
const longRunCheck = (await import("../lib/event-handlers/long-run-check.js")).default
const fileWatch = (await import("../lib/event-handlers/agent-file-watch-tick.js")).default
const chatUser = (await import("../lib/event-handlers/chat-user.js")).default
await loadCommands(new URL("../commands", import.meta.url).pathname)
const autoRefreshCommand = getHotCommands().get("auto_refresh")

const HOUR = 60 * 60_000
const transcriptPath = `${tempDir}/transcript.jsonl`
Deno.writeTextFileSync(transcriptPath, JSON.stringify({
    type: "assistant",
    timestamp: new Date().toISOString(),
    message: { model: "claude-opus-5", usage: { input_tokens: 1000, cache_read_input_tokens: 120000, cache_creation_input_tokens: 16000, output_tokens: 50 } },
}) + "\n")

function coreWith(lastStopAt, status = "idle") {
    return makeCore({
        chatState: { commandCenter: { chatId: "-100222", topicMap: { Old: "77" }, threadMap: { "77": "Old" }, topicNames: { "77": "gsc" } } },
        chatSessions: { Old: { id: "Old", title: "gsc", _conn: fakeConn(), status, lastStopAt, transcriptPath } },
    })
}

Deno.test("stale = idle, connected, and the last turn ended a cache-lifetime ago", () => {
    const now = Date.now()
    assert(isStaleSession({ _conn: fakeConn(), status: "idle", lastStopAt: now - 2 * HOUR }, now, HOUR))
    assert(!isStaleSession({ _conn: fakeConn(), status: "idle", lastStopAt: now - 10 * 60_000 }, now, HOUR))
    assert(!isStaleSession({ _conn: fakeConn(), status: "working", lastStopAt: now - 2 * HOUR }, now, HOUR))
    assert(!isStaleSession({ status: "idle", lastStopAt: now - 2 * HOUR }, now, HOUR), "a dead session is not stale, it is gone")
    assert(!isStaleSession({ _conn: fakeConn(), status: "idle", lastStopAt: now - 2 * HOUR, lastToolAt: now - 5000 }, now, HOUR), "a tool hook since the last Stop = mid-turn, not stale")
})

Deno.test("a stale topic gets 'consume Nk tokens?' exactly once per idle stretch", async () => {
    const core = coreWith(Date.now() - 2 * HOUR)
    const action = await staleCheck({ type: "stale_chat_check" }, core)
    const sends = effectsOfType(action, "send_text_to_user")
    assertEquals(sends.map((e) => e.text), ["consume 137k tokens? /refresh"])
    assertEquals(sends[0].replyTo.threadId, 77)

    Object.assign(core.chatSessions.Old, action.stateChanges.chatSessions.Old)
    assertEquals(await staleCheck({ type: "stale_chat_check" }, core), null)

    assertEquals(await staleCheck({ type: "stale_chat_check" }, coreWith(Date.now() - 5 * 60_000)), null, "fresh chats are left alone")
})

Deno.test("a message for a stale topic refreshes it and queues the message behind the handoff", () => {
    const delivery = deliverOrRefresh(coreWith(Date.now() - 2 * HOUR), "Old", "standup in 5", { source: "agent_timer" })
    const newId = delivery.refreshedTo
    assert(newId && newId !== "Old")
    assertEquals(effectsOfType(delivery, "deliver_channel_event"), [], "the stale session never sees it")
    assertEquals(effectsOfType(delivery, "spawn_dtach_session")[0].sessionId, newId)
    assertEquals(effectsOfType(delivery, "send_text_to_claude")[0], { type: "send_text_to_claude", sessionId: "Old", text: "/exit" })
    const queue = delivery.stateChanges.chatState.messageQueue
    assertEquals(queue.map((m) => [m.targetSessionId, m.meta.source]), [[newId, "refresh-context"], [newId, "agent_timer"]])
    assertEquals(queue[1].content, "standup in 5")
    assertEquals(delivery.stateChanges.chatState.commandCenter.threadMap["77"], newId)
})

Deno.test("a fresh session just gets the message", () => {
    const delivery = deliverOrRefresh(coreWith(Date.now() - 5 * 60_000), "Old", "hi", { source: "tell_session" })
    assertEquals(delivery.refreshedTo, null)
    assertEquals(delivery.effects, [{ type: "deliver_channel_event", sessionId: "Old", content: "hi", meta: { source: "tell_session" } }])
})

Deno.test("a repeating reminder follows the session it refreshed into", () => {
    const action = timerFire({ type: "agent_timer_fire", sessionId: "Old", timerId: "t1", message: "drink water", kind: "repeat", intervalMs: HOUR, fireCount: 0 }, coreWith(Date.now() - 2 * HOUR))
    const newId = action.stateChanges.chatState.messageQueue.at(-1).targetSessionId
    assertEquals(effectsOfType(action, "set_timer").find((e) => e.event.type === "agent_timer_fire").event.sessionId, newId)
    assertEquals(action.stateChanges.specialData.agentTimers.t1.sessionId, newId)
})

Deno.test("a daemon restart keeps lastStopAt, so a session idle across it still goes stale", async () => {
    const register = (await import("../lib/event-handlers/session-register.js")).default
    const lastStopAt = Date.now() - 2 * HOUR
    const core = coreWith(lastStopAt)
    const action = register({ type: "session_register", session: { id: "Old", cwd: "/repo", pid: 0 }, _conn: fakeConn(), ts: Date.now() }, core)
    const entry = action.stateChanges.chatSessions.Old
    assertEquals(entry.lastStopAt, lastStopAt)
    assert(isStaleSession({ ...entry, _conn: fakeConn() }, Date.now(), HOUR))
})

Deno.test("a background-task notice mid-turn (tool ran since the last Stop) is passed, not refreshed", async () => {
    const ups = (await import("../lib/event-handlers/claude-hook-user-prompt-submit.js")).default
    const core = coreWith(Date.now() - 11 * HOUR)
    core.chatSessions.Old.lastToolAt = Date.now() - 1000
    const action = ups({ type: "claude_hook_user_prompt_submit", sessionId: "Old", prompt: "<task-notification>done</task-notification>", _conn: fakeConn() }, core)
    assertEquals(action.effects.map((e) => e.message?.block), [false])
})

Deno.test("automatic wakes (long-run warning, file watch) refresh a stale topic instead of poking it", () => {
    const core = coreWith(Date.now() - 2 * HOUR)
    core.chatSessions.Old.pid = 5006
    const shell = "/bin/bash -c source /Users/x/.claude/shell-snapshots/snapshot-bash-1-abc.sh 2>/dev/null || true && eval 'cargo test' < /dev/null && pwd -P >| /tmp/claude-8dba-cwd"
    const warn = longRunCheck({ type: "long_run_check", ts: Date.now(), processes: [{ pid: 15, ppid: 5006, elapsedMs: 3 * HOUR, args: shell }] }, core)
    assertEquals(effectsOfType(warn, "send_text_to_claude"), [{ type: "send_text_to_claude", sessionId: "Old", text: "/exit" }], "only the /exit reaches the stale session")
    const newId = effectsOfType(warn, "spawn_dtach_session")[0].sessionId
    const queued = warn.stateChanges.chatState.messageQueue.at(-1)
    assertEquals([queued.targetSessionId, queued.meta.source], [newId, "long_run_warning"])
    assert(queued.content.includes("cargo test"))

    const watched = fileWatch({ sessionId: "Old", watchId: "w1", filePath: "/tmp/x", message: "x changed", status: "changed" }, core)
    assertEquals(effectsOfType(watched, "deliver_channel_event"), [])
    assertEquals(watched.stateChanges.chatState.messageQueue.at(-1).content, "x changed")
})

Deno.test("a long-run warning to a fresh session is still typed in directly", () => {
    const core = coreWith(Date.now() - 5 * 60_000)
    core.chatSessions.Old.pid = 5006
    const shell = "/bin/bash -c source /Users/x/.claude/shell-snapshots/snapshot-bash-1-abc.sh 2>/dev/null || true && eval 'make' < /dev/null && pwd -P >| /tmp/claude-8dba-cwd"
    const warn = longRunCheck({ type: "long_run_check", ts: Date.now(), processes: [{ pid: 15, ppid: 5006, elapsedMs: 10 * 60_000, args: shell }] }, core)
    assertEquals(effectsOfType(warn, "spawn_dtach_session"), [])
    assertEquals(effectsOfType(warn, "send_text_to_claude")[0].sessionId, "Old")
    assertEquals(warn.stateChanges.chatState, undefined)
})

function topicMessage(text) {
    return { type: "chat_user_message", ts: Date.now(), chatId: "-100222", threadId: 77, userId: "42", messageId: 9, chatType: "supergroup", text, replyTo: { chatId: "-100222", threadId: 77 } }
}

Deno.test("/auto_refresh on: my message to a stale topic goes to a fresh session; off (default) it goes to the old one", async () => {
    const core = coreWith(Date.now() - 2 * HOUR)
    const off = await chatUser(topicMessage("hello"), core)
    assertEquals(effectsOfType(off, "deliver_channel_event")[0].sessionId, "Old")
    assertEquals(effectsOfType(off, "spawn_dtach_session"), [])

    const toggled = await autoRefreshCommand(topicMessage("/auto_refresh on"), core)
    assertEquals(toggled.stateChanges.chatState.autoRefresh, { "-100222:77": true })
    assert(effectsOfType(toggled, "send_text_to_user")[0].text.includes("*on*"))
    core.chatState.autoRefresh = { "-100222:77": true }

    const on = await chatUser(topicMessage("hello"), core)
    assertEquals(effectsOfType(on, "deliver_channel_event"), [])
    const newId = effectsOfType(on, "spawn_dtach_session")[0].sessionId
    const queued = on.stateChanges.chatState.messageQueue.at(-1)
    assertEquals([queued.targetSessionId, queued.meta.chat_id], [newId, "-100222"])
    assert(queued.content.includes("hello"))

    core.chatSessions.Old.lastStopAt = Date.now() - 5 * 60_000
    const fresh = await chatUser(topicMessage("hello"), core)
    assertEquals(effectsOfType(fresh, "deliver_channel_event")[0].sessionId, "Old", "a non-stale session is left alone")
})

const promptSubmit = (await import("../lib/event-handlers/claude-hook-user-prompt-submit.js")).default
const NOTICE = "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command \"make apk\" completed (exit code 0)</summary>\n</task-notification>"

Deno.test("a background-task notice for a stale topic is blocked and handed to the refreshed session", () => {
    const conn = fakeConn()
    const action = promptSubmit({ type: "claude_hook_user_prompt_submit", sessionId: "Old", prompt: NOTICE, _conn: conn }, coreWith(Date.now() - 2 * HOUR))
    assertEquals(action.effects[0].type, "ipc_respond", "the decision goes before the slow refresh effects")
    assertEquals(action.effects[0].message.block, true)
    const newId = effectsOfType(action, "spawn_dtach_session")[0].sessionId
    const queued = action.stateChanges.chatState.messageQueue.find((m) => m.meta.source === "background_task_finished")
    assertEquals(queued.targetSessionId, newId)
    assert(queued.content.includes("make apk"))
})

Deno.test("a background-task notice for a fresh session, or any other prompt, passes through", () => {
    for (const [prompt, core] of [[NOTICE, coreWith(Date.now() - 5 * 60_000)], ["hello", coreWith(Date.now() - 2 * HOUR)]]) {
        const action = promptSubmit({ type: "claude_hook_user_prompt_submit", sessionId: "Old", prompt, _conn: fakeConn() }, core)
        assertEquals(action.effects.map((e) => [e.type, e.message?.block]), [["ipc_respond", false]])
    }
})
