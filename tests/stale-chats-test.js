import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, makeCore, fakeConn, effectsOfType } from "./_helpers.js"

const { tempDir } = setupTempPaths("cbg-stale-chats-test-")

const { isStaleSession, deliverOrRefresh } = await import("../lib/stale-chats.js")
const staleCheck = (await import("../lib/event-handlers/stale-chat-check.js")).default
const timerFire = (await import("../lib/event-handlers/agent-timer-fire.js")).default

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
