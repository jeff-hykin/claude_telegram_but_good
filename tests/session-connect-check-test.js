// tests/session-connect-check-test.js
//
// A topic session whose Telegram shim never connects (2026-10-26: the shim
// panicked on startup under Deno 2.7+) used to swallow every message sent to
// its topic until the shared queue overflowed with "queue full, dropped oldest
// entry". The connect check respawns it; a user message to a dead topic
// session respawns it; and queue entries for gone sessions are pruned.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, makeCore, effectsOfType } from "./_helpers.js"

const { paths } = setupTempPaths("cbg-connect-check-test-")
const COMMAND_CENTER = "-100"
Deno.writeTextFileSync(paths.ACCESS_FILE, JSON.stringify({
    dmPolicy: "pairing",
    allowFrom: ["42"],
    groups: {},
    pending: {},
    commandCenterChatId: COMMAND_CENTER,
}))

const handleConnectCheck = (await import("../lib/event-handlers/session-connect-check.js")).default
const handleChatUser = (await import("../lib/event-handlers/chat-user.js")).default

const DEAD_PID = 2_000_000_000
const ccFor = (sessionId) => ({ chatId: COMMAND_CENTER, topicNames: { "11384": "Life" }, threadMap: { "11384": sessionId }, topicMap: { [sessionId]: "11384" } })
const queued = (targetSessionId, content) => ({ targetSessionId, content, meta: {}, queuedAt: 1 })

Deno.test("connect check: a session that registered is left alone", () => {
    const core = makeCore({ chatState: { commandCenter: ccFor("Started") }, chatSessions: { Started: { pid: Deno.pid } } })
    assertEquals(handleConnectCheck({ type: "session_connect_check", sessionId: "Started" }, core), null)
})

Deno.test("connect check: a topic session that never connected is killed and respawned with its queued messages", () => {
    Deno.writeTextFileSync(paths.dtachSockFile("Stuck"), "")
    const core = makeCore({
        chatState: {
            commandCenter: ccFor("Stuck"),
            messageQueue: [queued("Stuck", "hi"), queued("LongDead", "old"), queued("Stuck", "you there?")],
        },
        chatSessions: {},
    })
    const action = handleConnectCheck({ type: "session_connect_check", sessionId: "Stuck", connectAttempt: 0 }, core)
    assertEquals(effectsOfType(action, "kill_dtach_session")[0].sessionId, "Stuck")
    const [spawn] = effectsOfType(action, "spawn_dtach_session")
    assertEquals(spawn.connectAttempt, 1)
    const chatState = action.stateChanges.chatState
    assertEquals(chatState.commandCenter.threadMap["11384"], spawn.sessionId)
    assert(chatState.messageQueue.every(entry => entry.targetSessionId === spawn.sessionId))
    assertEquals(chatState.messageQueue.slice(1).map(entry => entry.content), ["hi", "you there?"])
    Deno.removeSync(paths.dtachSockFile("Stuck"))
})

Deno.test("connect check: a respawn that also never connects is killed and reported, not respawned again", () => {
    const core = makeCore({ chatState: { commandCenter: ccFor("StuckAgain"), messageQueue: [] }, chatSessions: {} })
    const action = handleConnectCheck({ type: "session_connect_check", sessionId: "StuckAgain", connectAttempt: 1 }, core)
    assertEquals(effectsOfType(action, "kill_dtach_session").length, 1)
    assertEquals(effectsOfType(action, "spawn_dtach_session").length, 0)
    assertEquals(effectsOfType(action, "send_text_to_user").length, 1)
})

Deno.test("connect check: a session no topic routes to is left alone", () => {
    const core = makeCore({ chatState: { commandCenter: ccFor("Other") }, chatSessions: {} })
    assertEquals(handleConnectCheck({ type: "session_connect_check", sessionId: "Worker" }, core), null)
})

function topicMessage(text) {
    return {
        type: "chat_user_message",
        ts: 1_000_000,
        chatId: COMMAND_CENTER,
        threadId: 11384,
        userId: "42",
        username: "alice",
        messageId: 101,
        text,
        replyToMessageId: null,
        replyToText: null,
        attachment: null,
        chatType: "supergroup",
    }
}

Deno.test("chat-user: a message to a topic whose session is gone starts a new session and hands it the message", async () => {
    const core = makeCore({
        chatState: { commandCenter: ccFor("Gone"), messageQueue: [queued("Gone", "earlier")] },
        chatSessions: { Gone: { pid: DEAD_PID } },
    })
    const action = await handleChatUser(topicMessage("hello"), core)
    const [spawn] = effectsOfType(action, "spawn_dtach_session")
    assert(spawn, "expected a respawn")
    const queue = action.stateChanges.chatState.messageQueue
    assert(queue.every(entry => entry.targetSessionId === spawn.sessionId))
    assertEquals(queue.length, 3)
    assert(queue[2].content.includes("hello"))
})

Deno.test("chat-user: queueing for a starting session drops entries for gone sessions instead of reporting queue full", async () => {
    Deno.writeTextFileSync(paths.dtachSockFile("Starting"), "")
    const deadEntries = Array.from({ length: 50 }, (_, i) => queued(`Dead${i}`, "stale"))
    const core = makeCore({ chatState: { commandCenter: ccFor("Starting"), messageQueue: deadEntries }, chatSessions: {} })
    const action = await handleChatUser(topicMessage("hello"), core)
    const queue = action.stateChanges.chatState.messageQueue
    assertEquals(queue.map(entry => entry.targetSessionId), ["Starting"])
    const [notice] = effectsOfType(action, "send_text_to_user")
    assert(!notice.text.includes("queue full"))
    Deno.removeSync(paths.dtachSockFile("Starting"))
})
