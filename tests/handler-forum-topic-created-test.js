// tests/handler-forum-topic-created-test.js
//
// A hand-made command-center topic binds to an existing session by title.
// A disconnected match is only acceptable while its process still exists;
// a session whose pid is gone can never reconnect, and binding to it swallows
// every message the user sends (queued "for reconnect" forever).

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, makeCore, effectsOfType, paths } from "./_helpers.js"

setupTempPaths("cbg-forum-created-test-")
Deno.writeTextFileSync(paths.ACCESS_FILE, JSON.stringify({
    dmPolicy: "pairing", allowFrom: ["42"], groups: {}, pending: {}, commandCenterChatId: "-100",
}))

const handle = (await import("../lib/event-handlers/forum-topic-created.js")).default

const DEAD_PID = 2_000_000_000
const event = { type: "forum_topic_created", chatId: "-100", threadId: 55, topicTitle: "Newpipe", chatType: "supergroup", userId: "42" }

Deno.test("forum-created: a disconnected same-title session whose process is gone is NOT bound — /refresh is auto-spawned instead", () => {
    const core = makeCore({
        chatState: { commandCenter: { chatId: "-100", topicMap: {}, threadMap: {} } },
        chatSessions: { ShakyHawk: { title: "Newpipe", pid: DEAD_PID, disconnectedAt: 1 } },
    })
    const result = handle(event, core)
    assertEquals(result.stateChanges.chatState.commandCenter.threadMap["55"], undefined)
    assertEquals(result.followUpEvents?.[0]?.text, "/refresh")
})

Deno.test("forum-created: a disconnected same-title session whose process is still alive is bound", () => {
    const core = makeCore({
        chatState: { commandCenter: { chatId: "-100", topicMap: {}, threadMap: {} } },
        chatSessions: { LiveOne: { title: "Newpipe", pid: Deno.pid, disconnectedAt: 1 } },
    })
    const result = handle(event, core)
    assertEquals(result.stateChanges.chatState.commandCenter.threadMap["55"], "LiveOne")
    assert(effectsOfType(result, "send_text_to_user")[0].text.includes("LiveOne"))
})

Deno.test("forum-created: a connected same-title session wins over a dead one", () => {
    const core = makeCore({
        chatState: { commandCenter: { chatId: "-100", topicMap: {}, threadMap: {} } },
        chatSessions: {
            Dead: { title: "Newpipe", pid: DEAD_PID, disconnectedAt: 1 },
            Live: { title: "Newpipe", pid: Deno.pid, _conn: {} },
        },
    })
    assertEquals(handle(event, core).stateChanges.chatState.commandCenter.threadMap["55"], "Live")
})
