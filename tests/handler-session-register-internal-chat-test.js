// tests/handler-session-register-internal-chat-test.js
//
// Draining the message queue to a freshly registered session also stamps the
// reply obligation (`pendingNudgeAction`) and the `lastInbound` a reply would
// target. Neither may come from the internal pseudo-chat: interval-hook
// notices, CLI injections and kickoffs all arrive on "cbg-internal", which is
// not a Telegram chat, so a reply to it fails with "chat not found" and the
// outbound fallback redelivers it into whatever command-center topic the
// session is bound to — turning a daemon-internal event into a message
// addressed to the user.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, writeAccess, makeCore, get } from "./_helpers.js"

setupTempPaths("cbg-session-reg-internal-test-")

const handler = (await import("../lib/event-handlers/session-register.js")).default
const { INTERNAL_CHAT_ID, isInternalChatId } = await import("../lib/pure/internal-chat.js")

const SESSION_ID = "ProvincialParrotfish"

function queued(chatId, { messageId = "m1", content = "hello" } = {}) {
    return {
        targetSessionId: SESSION_ID,
        content,
        meta: { chat_id: chatId, message_id: messageId },
    }
}

function register(queue) {
    writeAccess(["42"])
    const core = makeCore({ chatState: { messageQueue: queue } })
    const action = handler({
        type: "session_register",
        session: { id: SESSION_ID, cwd: "/repo/foo", pid: 0 },
    }, core)
    return get(action, `stateChanges.chatSessions.${SESSION_ID}`) ?? {}
}

Deno.test("internal-chat: predicate matches only the pseudo-chat", () => {
    assert(isInternalChatId(INTERNAL_CHAT_ID))
    assert(isInternalChatId("cbg-internal"))
    assertEquals(isInternalChatId("-1003924773219"), false)
    assertEquals(isInternalChatId(null), false)
    assertEquals(isInternalChatId(undefined), false)
})

Deno.test("a hook notice alone owes the user no reply", () => {
    const patch = register([queued(INTERNAL_CHAT_ID, { content: "interval hook ih_9f7204 errored" })])
    assertEquals(patch.pendingNudgeAction, undefined)
    assertEquals(patch.lastInbound, undefined)
    // the session is still handed the work
    assertEquals(patch.status, "working")
})

Deno.test("a hook notice queued without any chat_id owes the user no reply", () => {
    // interval-hook-actions queues hook notices with meta {source, user} only
    const patch = register([{
        targetSessionId: SESSION_ID,
        content: "[interval hook ih_9f7204 → topic dimSLAM] warning",
        meta: { source: "interval_hook", user: "hook:ih_9f7204" },
    }])
    assertEquals(patch.pendingNudgeAction, undefined)
    assertEquals(patch.lastInbound, undefined)
    assertEquals(patch.status, "working")
})

Deno.test("a real chat message still owes the user a reply", () => {
    const patch = register([queued("-1003924773219", { messageId: "54796" })])
    assertEquals(patch.pendingNudgeAction, "askAgentToSendChatMessage")
    assertEquals(patch.lastInbound.chatId, "-1003924773219")
    assertEquals(patch.lastInbound.messageId, "54796")
})

Deno.test("a hook notice arriving after a real message does not steal the reply target", () => {
    const patch = register([
        queued("-1003924773219", { messageId: "54796", content: "please fix this cbg bug" }),
        queued(INTERNAL_CHAT_ID, { messageId: "cbg-1", content: "hook errored" }),
    ])
    assertEquals(patch.pendingNudgeAction, "askAgentToSendChatMessage")
    assertEquals(patch.lastInbound.chatId, "-1003924773219")
    assertEquals(patch.lastInbound.messageId, "54796")
    assert(!patch.lastInbound.text.includes("hook errored"))
})

Deno.test("the newest real message wins when several are queued", () => {
    const patch = register([
        queued("42", { messageId: "1" }),
        queued(INTERNAL_CHAT_ID, { messageId: "cbg-1" }),
        queued("99", { messageId: "2" }),
    ])
    assertEquals(patch.lastInbound.chatId, "99")
    assertEquals(patch.lastInbound.messageId, "2")
})

Deno.test("internal entries are still delivered to the session", () => {
    writeAccess(["42"])
    const core = makeCore({ chatState: { messageQueue: [queued(INTERNAL_CHAT_ID)] } })
    const action = handler({
        type: "session_register",
        session: { id: SESSION_ID, cwd: "/repo/foo", pid: 0 },
    }, core)
    const delivered = (action.effects ?? []).filter(e => e.type === "deliver_channel_event")
    assertEquals(delivered.length, 1)
    assertEquals(delivered[0]._chatId, INTERNAL_CHAT_ID)
})

// ── the Stop-hook pendingQueue drain has the same obligation to honour ──

const stopHandler = (await import("../lib/event-handlers/claude-hook-stop.js")).default

function stopWithQueued(entry) {
    writeAccess(["42"])
    const core = makeCore({
        chatSessions: {
            [SESSION_ID]: {
                id: SESSION_ID,
                cwd: "/repo/foo",
                pendingQueue: [entry],
                pendingNudgeAction: "none",
            },
        },
    })
    const action = stopHandler({ type: "claude_hook_stop", sessionId: SESSION_ID, ts: 1000 }, core)
    return get(action, `stateChanges.chatSessions.${SESSION_ID}`) ?? {}
}

Deno.test("stop-drain: an internal-chat entry owes the user no reply", () => {
    const patch = stopWithQueued({
        chatId: INTERNAL_CHAT_ID, messageId: "cbg-1", text: "hook errored", _source: "cli",
    })
    // the drain leaves the obligation untouched rather than arming it, so the
    // session keeps the "none" it already had
    assertEquals(patch.pendingNudgeAction, undefined)
    assertEquals(patch.lastInbound, undefined)
    // the entry is still consumed rather than left to redeliver forever
    assertEquals(patch.pendingQueue, [])
})

Deno.test("stop-drain: a real chat entry still owes the user a reply", () => {
    const patch = stopWithQueued({
        chatId: "-1003924773219", messageId: "54796", text: "please fix this cbg bug",
    })
    assertEquals(patch.pendingNudgeAction, "askAgentToSendChatMessage")
    assertEquals(patch.lastInbound.chatId, "-1003924773219")
})
