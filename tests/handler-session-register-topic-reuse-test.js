// tests/handler-session-register-topic-reuse-test.js
//
// A session registering under a title whose command-center topic belongs to a
// gone session takes that topic over instead of creating a duplicate — every
// respawn of the MrClank group session used to add another "MrClank" topic.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, makeCore, paths, effectsOfType } from "./_helpers.js"

setupTempPaths("cbg-session-reg-topic-reuse-test-")
Deno.writeTextFileSync(paths.ACCESS_FILE, JSON.stringify({ dmPolicy: "pairing", allowFrom: ["42"], groups: {}, pending: {}, commandCenterChatId: "-100222" }))

const handler = (await import("../lib/event-handlers/session-register.js")).default
const DEAD_PID = 2_000_000_000

function register(chatSessions, threadMap, topicNames) {
    const topicMap = Object.fromEntries(Object.entries(threadMap).map(([thread, sid]) => [sid, thread]))
    const core = makeCore({
        chatState: { commandCenter: { chatId: "-100222", threadMap, topicMap, topicNames } },
        chatSessions: { ...chatSessions, New: { id: "New", title: "MrClank" } },
    })
    return handler({ type: "session_register", session: { id: "New", title: "MrClank", cwd: "/tmp", pid: 0 } }, core)
}

Deno.test("a gone session's same-named topic is reused (newest one), not duplicated", () => {
    const action = register(
        { Old1: { id: "Old1", pid: DEAD_PID }, Old2: { id: "Old2", pid: DEAD_PID } },
        { "100": "Old1", "200": "Old2" },
        { "100": "MrClank", "200": "MrClank" },
    )
    assertEquals(effectsOfType(action, "create_thread"), [])
    const cc = action.stateChanges.chatState.commandCenter
    assertEquals(cc.threadMap["200"], "New")
    assertEquals(cc.topicMap.New, "200")
    assertEquals(cc.topicMap.Old2, undefined)
})

Deno.test("a same-named topic whose session is alive is left alone", () => {
    const action = register({ Live: { id: "Live", pid: Deno.pid } }, { "100": "Live" }, { "100": "MrClank" })
    assertEquals(effectsOfType(action, "create_thread").length, 1)
})
