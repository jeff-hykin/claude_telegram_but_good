// tests/handler-scheduled-task-routing-test.js
//
// A scheduled task must report back to the chat AND topic it was created in.
// Before this, create_scheduled_task stored every task under allowFrom[0] —
// the owner's DM — and run-complete hardcoded threadId:null, so a task made
// from a group topic sent its output to a DM the user had stopped reading.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, makeCore, fakeConn, effectsOfType } from "./_helpers.js"

setupTempPaths("cbg-sched-routing-test-")

const createTask = (await import("../lib/event-handlers/create-scheduled-task.js")).default
const runComplete = (await import("../lib/event-handlers/scheduled-task-run-complete.js")).default

const GROUP = "-1003924773219"
const TOPIC = 11384

// A session living in a group topic, as the command-center topic map records it.
function coreInTopic(sessionId = "sess-1") {
    return makeCore({
        chatState: {
            commandCenter: { chatId: GROUP, topicMap: { [sessionId]: TOPIC } },
        },
        chatSessions: { [sessionId]: {} },
    })
}

function createEvent(sessionId = "sess-1") {
    return {
        sessionId,
        requestId: "req-1",
        _conn: fakeConn(),
        title: "Wake before the stage demo",
        definitionOfDone: "Send one line if the run-through has not happened.",
        rule: { freq: "DAILY", byhour: [7], byminute: [30], count: 1, tzid: "America/New_York" },
    }
}

function ownerOf(specialData) {
    const byChat = specialData.scheduledTaskByChatId ?? {}
    const chatId = Object.keys(byChat)[0]
    const task = Object.values(byChat[chatId] ?? {})[0]
    return { chatId, task }
}

Deno.test("create: task is owned by the session's chat, not the DM in allowFrom", async () => {
    const core = coreInTopic()
    const action = await createTask(createEvent(), core)
    const { chatId } = ownerOf(action.stateChanges.specialData)
    assertEquals(chatId, GROUP)
})

Deno.test("create: task records the topic it was created in", async () => {
    const core = coreInTopic()
    const action = await createTask(createEvent(), core)
    const { task } = ownerOf(action.stateChanges.specialData)
    assertEquals(task.threadId, TOPIC)
})

Deno.test("create: confirmation goes to the same topic", async () => {
    const core = coreInTopic()
    const action = await createTask(createEvent(), core)
    const sends = effectsOfType(action, "send_text_to_user")
    assertEquals(sends.length, 1)
    assertEquals(sends[0].replyTo.chatId, GROUP)
    assertEquals(sends[0].replyTo.threadId, TOPIC)
})

Deno.test("run output returns to the task's topic, not the group root", async () => {
    const task = {
        id: "sch_test1",
        title: "t",
        threadId: TOPIC,
        state: "scheduled",
        rule: { freq: "DAILY", byhour: [7], byminute: [30], count: 1, tzid: "America/New_York" },
        tracking: { totalRuns: 0, runHistory: [] },
        currentRun: null,
    }
    const core = makeCore({
        specialData: { scheduledTaskByChatId: { [GROUP]: { [task.id]: task } } },
    })
    const action = await runComplete({
        chatId: GROUP,
        scheduleTaskId: task.id,
        runIso: "2026-09-23T11:30:21.037Z",
        status: "certified",
        summary: "did the thing",
    }, core)
    const sends = effectsOfType(action, "send_text_to_user")
    assertEquals(sends.length, 1)
    assertEquals(sends[0].replyTo.chatId, GROUP)
    assertEquals(sends[0].replyTo.threadId, TOPIC)
})
