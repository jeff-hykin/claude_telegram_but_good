// tests/interval-hook-topic-delivery-test.js
//
// buildTopicDeliveryAction decides between delivering to the topic's bound
// session and "resurrecting" the topic with a fresh one. Right after a daemon
// restart every session is briefly disconnected while its shim reconnects;
// a session whose process is alive must be queued for, not replaced —
// replacing it strands a veteran session on a brand-new thread.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, makeCore, effectsOfType } from "./_helpers.js"

const { paths } = setupTempPaths("cbg-ihook-delivery-test-")
const { buildTopicDeliveryAction } = await import("../lib/interval-hook-actions.js")

const DEAD_PID = 2_000_000_000
const cc = { chatId: "-100", topicNames: { "11384": "Life" }, threadMap: { "11384": "Veteran" }, topicMap: { Veteran: "11384" } }

Deno.test("topic delivery: a bound session that is disconnected but whose process is ALIVE gets a targeted queue entry, not a replacement", () => {
    const core = makeCore({
        chatState: { commandCenter: cc, messageQueue: [] },
        chatSessions: { Veteran: { title: "Life", pid: Deno.pid, disconnectedAt: 1 } },
    })
    const action = buildTopicDeliveryAction(core, "Life", "hello", { source: "interval_hook" })
    assertEquals(effectsOfType(action, "spawn_dtach_session").length, 0)
    const queue = action.stateChanges.chatState.messageQueue
    assertEquals(queue.length, 1)
    assertEquals(queue[0].targetSessionId, "Veteran")
    assertEquals(action.stateChanges.chatState.commandCenter, undefined)
})

Deno.test("topic delivery: a bound session whose process is GONE is replaced (resurrect)", () => {
    const core = makeCore({
        chatState: { commandCenter: cc, messageQueue: [] },
        chatSessions: { Veteran: { title: "Life", pid: DEAD_PID, disconnectedAt: 1 } },
    })
    const action = buildTopicDeliveryAction(core, "Life", "hello", {})
    const spawns = effectsOfType(action, "spawn_dtach_session")
    assertEquals(spawns.length, 1)
    assertEquals(action.stateChanges.chatState.commandCenter.threadMap["11384"], spawns[0].sessionId)
    assertEquals(action.stateChanges.chatState.commandCenter.topicMap.Veteran, undefined)
})

Deno.test("topic delivery: a connected bound session is delivered to directly", () => {
    const core = makeCore({
        chatState: { commandCenter: cc },
        chatSessions: { Veteran: { title: "Life", pid: Deno.pid, _conn: {} } },
    })
    const action = buildTopicDeliveryAction(core, "Life", "hello", {})
    assertEquals(effectsOfType(action, "deliver_channel_event")[0].sessionId, "Veteran")
    assert(!action.stateChanges)
})

Deno.test("topic delivery: a second hook in the same tick queues for the session the first one is spawning, instead of spawning another", () => {
    const core = makeCore({
        chatState: { commandCenter: cc, messageQueue: [] },
        chatSessions: { Veteran: { title: "Life", pid: DEAD_PID, disconnectedAt: 1 } },
    })
    const first = buildTopicDeliveryAction(core, "Life", "nutrition", {})
    const spawnedId = effectsOfType(first, "spawn_dtach_session")[0].sessionId
    Deno.writeTextFileSync(paths.dtachSockFile(spawnedId), "")
    const afterFirst = makeCore({
        chatState: { commandCenter: { ...cc, threadMap: { "11384": spawnedId }, topicMap: { [spawnedId]: "11384" } }, messageQueue: first.stateChanges.chatState.messageQueue },
        chatSessions: { Veteran: { title: "Life", pid: DEAD_PID, disconnectedAt: 1 } },
    })
    const second = buildTopicDeliveryAction(afterFirst, "Life", "todo nudge", {})
    assertEquals(effectsOfType(second, "spawn_dtach_session").length, 0)
    const queue = second.stateChanges.chatState.messageQueue
    assertEquals(queue.map((entry) => entry.targetSessionId), [spawnedId, spawnedId])
})

Deno.test("topic delivery: a bound session that never registered and has no socket (spawn failed) is resurrected", () => {
    const core = makeCore({
        chatState: { commandCenter: { ...cc, threadMap: { "11384": "NeverStarted" }, topicMap: { NeverStarted: "11384" } }, messageQueue: [] },
        chatSessions: {},
    })
    const action = buildTopicDeliveryAction(core, "Life", "hello", {})
    assertEquals(effectsOfType(action, "spawn_dtach_session").length, 1)
})
