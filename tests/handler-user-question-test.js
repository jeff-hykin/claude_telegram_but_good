// tests/handler-user-question-test.js
//
// Button questions any harness can ask the user. The send side of inline
// keyboards already worked; what these cover is the RETURN path —
// telegram-callback-query.js used to understand exactly two callback_data
// prefixes and log every other tap into the void.
//
// The three asking paths (MCP tool, slash-command follow-up event, CLI) all
// converge on the `ask_user_question` handler, so most of this exercises that
// handler, the callback branch, and expiry.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, makeCore, fakeConn, effectsOfType, get, writeAccess } from "./_helpers.js"

setupTempPaths("cbg-user-question-test-")
writeAccess(["-100777"])

const ask = (await import("../lib/event-handlers/ask-user-question.js")).default
const callback = (await import("../lib/event-handlers/telegram-callback-query.js")).default
const expire = (await import("../lib/event-handlers/user-question-expire.js")).default
const rehydrate = (await import("../lib/event-handlers/user-question-rehydrate.js")).default
const channel = (await import("../lib/event-handlers/claude-channel.js")).default
const cliCommand = (await import("../lib/event-handlers/cli-command.js")).default
const { translateTelegramMessage } = await import("../lib/pure/telegram-translator.js")
const {
    decodeCallbackData,
    encodeCallbackData,
    normalizeOptions,
    validateAsk,
    buildKeyboard,
    expiryDelayMs,
    MAX_OPTIONS,
    MAX_QUESTION_CHARS,
    EXPIRE_RESUME_GRACE_MS,
    DEFAULT_TTL_MS,
} = await import("../lib/pure/user-questions.js")
const { QUESTION_LOG_INBOX } = await import("../lib/user-question-actions.js")

const CHAT = "-100777"
const SESSION = "OccasionalCapybara"

/** A core with one live session bound to the "life" topic. */
function coreWithSession(extra = {}) {
    return makeCore({
        chatSessions: { [SESSION]: { id: SESSION, _conn: fakeConn("shim") } },
        chatState: {
            commandCenter: { chatId: CHAT, topicMap: { [SESSION]: 7 }, topicNames: { 7: "life" } },
            ...extra,
        },
    })
}

function askEvent(overrides = {}) {
    return {
        type: "ask_user_question",
        ts: 1_000_000,
        question: "still want this todo?",
        options: ["Keep", "Drop"],
        askedBy: { kind: "session", id: SESSION },
        ...overrides,
    }
}

function questionsOf(action) {
    return get(action, "stateChanges.chatState.pendingQuestions") ?? {}
}

// ── the wire format ───────────────────────────────────────────────────

Deno.test("callback data: round-trips, and ignores the other prefixes", () => {
    assertEquals(decodeCallbackData(encodeCallbackData("q_abc", 2)), { questionId: "q_abc", index: 2 })
    assertEquals(decodeCallbackData("perm:allow:req-1"), null)
    assertEquals(decodeCallbackData("cmderr:fix:ab12"), null)
    assertEquals(decodeCallbackData(""), null)
    assertEquals(decodeCallbackData(undefined), null)
})

Deno.test("callback data: stays inside Telegram's 64-byte cap", () => {
    const data = encodeCallbackData("q_m1k2j3h4ffff", 4)
    assert(new TextEncoder().encode(data).length <= 64, data)
})

Deno.test("options: strings and objects both normalize, keys default to a slug", () => {
    assertEquals(normalizeOptions(["Keep it", "Drop"]).options, [
        { key: "keep_it", label: "Keep it" },
        { key: "drop", label: "Drop" },
    ])
    assertEquals(normalizeOptions([{ key: "k", label: "✅ Keep" }, { key: "d", label: "❌ Drop" }]).options, [
        { key: "k", label: "✅ Keep" },
        { key: "d", label: "❌ Drop" },
    ])
})

Deno.test("options: the limits are enforced, not silently truncated", () => {
    assert(normalizeOptions([]).error)
    assert(normalizeOptions("Keep").error)
    assert(normalizeOptions(new Array(MAX_OPTIONS + 1).fill("x")).error)
    assert(normalizeOptions(["x".repeat(41), "ok"]).error)
    assert(normalizeOptions(["only one"]).error, "a single button is an announcement, not a question")
    assert(normalizeOptions(["Keep", "keep"]).error, "duplicate slug keys are rejected")
    assert(normalizeOptions(["", "ok"]).error)
})

Deno.test("validateAsk: rejects an oversized question, clamps the ttl", () => {
    assert(validateAsk({ question: "", options: ["a", "b"] }).error)
    assert(validateAsk({ question: "x".repeat(MAX_QUESTION_CHARS + 1), options: ["a", "b"] }).error)
    assert(validateAsk({ question: "ok?", options: ["a", "b"], ttlSeconds: -5 }).error)
    assertEquals(validateAsk({ question: "ok?", options: ["a", "b"] }).ttlMs, DEFAULT_TTL_MS)
    // A week is the cap.
    assertEquals(validateAsk({ question: "ok?", options: ["a", "b"], ttlSeconds: 99 * 24 * 3600 }).ttlMs, 7 * 24 * 3600 * 1000)
    // A 10-second question is raised to the minute floor rather than refused.
    assertEquals(validateAsk({ question: "ok?", options: ["a", "b"], ttlSeconds: 10 }).ttlMs, 60_000)
})

Deno.test("keyboard: two buttons per row, each carrying its own index", () => {
    const rows = buildKeyboard("q_x", [{ key: "a", label: "A" }, { key: "b", label: "B" }, { key: "c", label: "C" }])
    assertEquals(rows.length, 2)
    assertEquals(rows[0].map((b) => b.callbackData), ["q:q_x:0", "q:q_x:1"])
    assertEquals(rows[1][0].callbackData, "q:q_x:2")
})

// ── asking ────────────────────────────────────────────────────────────

Deno.test("ask: registers the question, sends the keyboard, arms expiry", () => {
    const action = ask(askEvent({ questionId: "q_fixed" }), coreWithSession())

    const record = questionsOf(action).q_fixed
    assertEquals(record.question, "still want this todo?")
    assertEquals(record.options.map((o) => o.key), ["keep", "drop"])
    assertEquals(record.chatId, CHAT)
    assertEquals(record.threadId, 7, "asked in the asking session's own topic")
    assertEquals(record.expiresAt, 1_000_000 + DEFAULT_TTL_MS)

    const sends = effectsOfType(action, "send_text_to_user")
    assertEquals(sends.length, 1)
    assertEquals(sends[0].options.buttons[0].map((b) => b.callbackData), ["q:q_fixed:0", "q:q_fixed:1"])
    // The sent message's id is stashed back so the keyboard can be edited away.
    assertEquals(sends[0].stashQuestionMessageId, "q_fixed")

    const timers = effectsOfType(action, "set_timer")
    assertEquals(timers.length, 1)
    assertEquals(timers[0].event, { type: "user_question_expire", questionId: "q_fixed" })
})

Deno.test("ask: a session's answer comes back through its TOPIC by default", () => {
    // A /refresh gives the work a new session id; the topic follows the work,
    // so resolving at answer time through the topic is what survives it.
    const action = ask(askEvent({ questionId: "q_a" }), coreWithSession())
    assertEquals(questionsOf(action).q_a.answerTo, "topic:life")
})

Deno.test("ask: an explicit answer_to wins", () => {
    const action = ask(askEvent({ questionId: "q_a", answerTo: "inbox:my_script" }), coreWithSession())
    assertEquals(questionsOf(action).q_a.answerTo, "inbox:my_script")
})

Deno.test("ask: with no topic and no chat, falls back to the allowlisted chat", () => {
    const core = makeCore({ chatSessions: { [SESSION]: { id: SESSION, _conn: fakeConn("c") } } })
    const action = ask(askEvent({ questionId: "q_a" }), core)
    assertEquals(questionsOf(action).q_a.chatId, CHAT)
    assertEquals(questionsOf(action).q_a.answerTo, `session:${SESSION}`)
})

Deno.test("ask: a bad question fails loudly to whoever is waiting", () => {
    const conn = fakeConn("cli")
    const action = ask(askEvent({ options: ["only-one"], _conn: conn, requestId: "q_bad" }), coreWithSession())
    assertEquals(questionsOf(action).q_bad, undefined)
    const responses = effectsOfType(action, "ipc_respond")
    assertEquals(responses.length, 1)
    assertEquals(responses[0].message.ok, false)
    assert(responses[0].message.error.includes("option"))
})

Deno.test("ask: a bad question from a command says so in the chat", () => {
    const action = ask(askEvent({ options: [], chatId: CHAT, askedBy: { kind: "command", id: "agenda" } }), coreWithSession())
    const sends = effectsOfType(action, "send_text_to_user")
    assertEquals(sends.length, 1)
    assert(sends[0].text.includes("could not ask"))
    assertEquals(effectsOfType(action, "set_timer").length, 0)
})

Deno.test("ask: a waiting caller is acked with the question id", () => {
    const action = ask(askEvent({ questionId: "q_a", _conn: fakeConn("cli"), requestId: "q_a" }), coreWithSession())
    const ack = effectsOfType(action, "ipc_respond")[0]
    assertEquals(ack.message.ok, true)
    assertEquals(ack.message.questionId, "q_a")
    assertEquals(ack.closeAfter, false, "sync CLI needs the conn for the answer frame")
})

// ── the MCP tool ──────────────────────────────────────────────────────

Deno.test("ask_user_question tool: answers with an id immediately and asks via a follow-up", () => {
    const action = channel({
        type: "claude_channel_tool_request",
        ts: 1_000,
        sessionId: SESSION,
        requestId: "req-1",
        toolName: "ask_user_question",
        args: { question: "ship it?", options: ["Ship", "Hold"] },
        _conn: fakeConn("shim"),
    }, coreWithSession())

    const responses = effectsOfType(action, "ipc_respond")
    assertEquals(responses.length, 1)
    const payload = JSON.parse(responses[0].message.result.content[0].text)
    assert(payload.question_id.startsWith("q_"))

    assertEquals(action.followUpEvents.length, 1)
    const followUp = action.followUpEvents[0]
    assertEquals(followUp.type, "ask_user_question")
    assertEquals(followUp.questionId, payload.question_id)
    assertEquals(followUp.askedBy, { kind: "session", id: SESSION })
})

// ── the CLI ───────────────────────────────────────────────────────────

Deno.test("cbg question: parks the conn on an inbox in --sync mode", () => {
    const conn = fakeConn("cli")
    const action = cliCommand({
        type: "cli_command",
        kind: "ask_user_question",
        ts: 2_000,
        payload: { question: "deploy?", options: ["Yes", "No"], waitInbox: "cliq_1" },
        _conn: conn,
    }, makeCore())

    const waiters = effectsOfType(action, "register_inbox_waiter")
    assertEquals(waiters.length, 1)
    assertEquals(waiters[0].address, "cliq_1")
    const followUp = action.followUpEvents[0]
    assertEquals(followUp.answerTo, "inbox:cliq_1")
    assertEquals(followUp.closeConnAfter, false)
})

Deno.test("cbg question: without --sync the answer still has an address", () => {
    const action = cliCommand({
        type: "cli_command",
        kind: "ask_user_question",
        ts: 2_000,
        payload: { question: "deploy?", options: ["Yes", "No"] },
        _conn: fakeConn("cli"),
    }, makeCore())
    assertEquals(effectsOfType(action, "register_inbox_waiter").length, 0)
    const followUp = action.followUpEvents[0]
    assertEquals(followUp.answerTo, `inbox:${followUp.questionId}`)
    assertEquals(followUp.closeConnAfter, true)
})

Deno.test("cbg question: a one-option question is refused before anything is created", () => {
    const action = cliCommand({
        type: "cli_command",
        kind: "ask_user_question",
        ts: 2_000,
        payload: { question: "deploy?", options: ["Yes"] },
        _conn: fakeConn("cli"),
    }, makeCore())
    assertEquals(action.followUpEvents, undefined)
    assertEquals(effectsOfType(action, "ipc_respond")[0].message.ok, false)
})

// ── answering ─────────────────────────────────────────────────────────

function pendingCore(record, sessions = { [SESSION]: { id: SESSION, _conn: fakeConn("shim") } }) {
    return makeCore({
        chatSessions: sessions,
        chatState: {
            commandCenter: { chatId: CHAT, topicMap: { [SESSION]: 7 }, topicNames: { 7: "life" } },
            pendingQuestions: { [record.id]: record },
        },
    })
}

function makeRecord(overrides = {}) {
    return {
        id: "q_x",
        question: "still want this todo?",
        context: null,
        options: [{ key: "keep", label: "Keep" }, { key: "drop", label: "Drop" }],
        answerTo: `session:${SESSION}`,
        askedBy: { kind: "session", id: SESSION, topicName: "life" },
        chatId: CHAT,
        threadId: 7,
        messageId: 4242,
        createdAt: 1_000,
        expiresAt: 1_000 + DEFAULT_TTL_MS,
        ...overrides,
    }
}

function tap(index = 0, overrides = {}) {
    return {
        type: "telegram_callback_query",
        ts: 5_000,
        chatId: CHAT,
        userId: "42",
        queryId: "cbq-1",
        messageId: 4242,
        data: `q:q_x:${index}`,
        ...overrides,
    }
}

Deno.test("tap: the answer reaches the asking session and the question closes", () => {
    const action = callback(tap(0), pendingCore(makeRecord()))

    const delivered = effectsOfType(action, "deliver_channel_event")
    assertEquals(delivered.length, 1)
    assertEquals(delivered[0].sessionId, SESSION)
    assert(delivered[0].content.includes("Keep"))
    assertEquals(delivered[0].meta.source, "user_question")
    assertEquals(delivered[0].meta.answerKey, "keep")

    // The keyboard is edited away so the same question can't be answered twice.
    const edits = effectsOfType(action, "edit_telegram_message")
    assertEquals(edits.length, 1)
    assertEquals(edits[0].messageId, 4242)
    assertEquals(edits[0].options.reply_markup, { inline_keyboard: [] })

    // Telegram's spinner always gets dismissed.
    assertEquals(effectsOfType(action, "answer_callback_query").length, 1)

    assertEquals(get(action, "stateChanges.chatState.pendingQuestions.q_x"), undefined)
    assert("q_x" in get(action, "stateChanges.chatState.pendingQuestions"))
})

Deno.test("tap: every answer is also logged to one durable inbox", () => {
    const writes = effectsOfType(callback(tap(1), pendingCore(makeRecord())), "write_inbox")
    assertEquals(writes.length, 1)
    assertEquals(writes[0].address, QUESTION_LOG_INBOX)
    assertEquals(writes[0].message.meta.answer.key, "drop")
})

Deno.test("tap: an asker that went away gets its answer in the inbox, not dropped", () => {
    // topic:life with no connected session in it — the session refreshed,
    // crashed, or the daemon restarted before the tap.
    const core = pendingCore(makeRecord({ answerTo: "topic:life" }), {})
    const action = callback(tap(0), core)

    assertEquals(effectsOfType(action, "deliver_channel_event").length, 0)
    const writes = effectsOfType(action, "write_inbox")
    assertEquals(writes.map((w) => w.address), [QUESTION_LOG_INBOX, "topic:life"])
    // ...and a parked `cbg question --sync` on that address is woken.
    assertEquals(effectsOfType(action, "notify_inbox_waiter")[0].address, "topic:life")
})

Deno.test("tap: an inbox target is written and its waiter notified", () => {
    const action = callback(tap(0), pendingCore(makeRecord({ answerTo: "inbox:cliq_1" })))
    assertEquals(effectsOfType(action, "write_inbox").map((w) => w.address), [QUESTION_LOG_INBOX, "cliq_1"])
    assertEquals(effectsOfType(action, "notify_inbox_waiter")[0].address, "cliq_1")
})

Deno.test("tap: a question nobody recorded says so instead of hanging", () => {
    const action = callback(tap(0), makeCore())
    assertEquals(effectsOfType(action, "deliver_channel_event").length, 0)
    const answered = effectsOfType(action, "answer_callback_query")
    assertEquals(answered.length, 1)
    assert(answered[0].text.includes("already answered"))
    // A double-tap must not overwrite the "answered" text already on the message.
    assertEquals(effectsOfType(action, "edit_telegram_message").length, 0)
})

Deno.test("tap: a half-written record is treated as closed, not crashed into", () => {
    // The message-id stash can only ever re-create `{messageId, chatId}` for a
    // question that was answered while its send was still in flight.
    const core = makeCore({ chatState: { pendingQuestions: { q_x: { messageId: 4242, chatId: CHAT } } } })
    const action = callback(tap(0), core)
    assertEquals(effectsOfType(action, "deliver_channel_event").length, 0)
    assertEquals(effectsOfType(action, "answer_callback_query").length, 1)
})

Deno.test("tap: an out-of-range option index answers the query and changes nothing", () => {
    const action = callback(tap(9), pendingCore(makeRecord()))
    assertEquals(effectsOfType(action, "deliver_channel_event").length, 0)
    assertEquals(effectsOfType(action, "answer_callback_query")[0].text, "unknown option")
    assertEquals(action.stateChanges, {})
})

Deno.test("tap: the other callback prefixes still work", () => {
    const core = makeCore({
        chatState: { commandErrors: { ab12: { cmdName: "agenda", error: "boom", stack: "", originalText: "/agenda" } }, focusedSessionId: SESSION },
        chatSessions: { [SESSION]: { id: SESSION, _conn: fakeConn("shim") } },
    })
    const action = callback({ ...tap(0), data: "cmderr:fix:ab12" }, core)
    assertEquals(effectsOfType(action, "deliver_channel_event").length, 1)
})

// ── expiry ────────────────────────────────────────────────────────────

Deno.test("expire: an unanswered question tells its asker and closes", () => {
    const record = makeRecord({ expiresAt: 4_000 })
    const action = expire({ type: "user_question_expire", ts: 5_000, questionId: "q_x" }, pendingCore(record))

    const delivered = effectsOfType(action, "deliver_channel_event")
    assertEquals(delivered.length, 1)
    assertEquals(delivered[0].meta.status, "expired")
    assert(delivered[0].content.includes("expired"))
    assertEquals(effectsOfType(action, "edit_telegram_message").length, 1)
    assertEquals(get(action, "stateChanges.chatState.pendingQuestions.q_x"), undefined)
})

Deno.test("expire: firing early re-arms instead of killing a live question", () => {
    const record = makeRecord({ expiresAt: 9_000 })
    const action = expire({ type: "user_question_expire", ts: 5_000, questionId: "q_x" }, pendingCore(record))
    assertEquals(effectsOfType(action, "set_timer").length, 1)
    assertEquals(effectsOfType(action, "deliver_channel_event").length, 0)
    assertEquals(action.stateChanges, undefined)
})

Deno.test("expire: an already-answered question is a no-op", () => {
    assertEquals(expire({ type: "user_question_expire", questionId: "q_gone" }, makeCore()), null)
})

Deno.test("rehydrate: a restart re-arms the expiry timer from the record", () => {
    const soon = Date.now() + 60 * 60 * 1000
    const action = rehydrate({ type: "user_question_rehydrate", questionId: "q_x" }, pendingCore(makeRecord({ expiresAt: soon })))
    const armed = effectsOfType(action, "set_timer")
    assertEquals(armed.length, 1)
    assert(Math.abs(armed[0].delayMs - (soon - Date.now())) < 2000)
})

Deno.test("expiryDelayMs: a deadline slept through fires shortly after boot", () => {
    const now = 1_000_000
    assertEquals(expiryDelayMs({ expiresAt: now + 5000 }, now), 5000)
    assertEquals(expiryDelayMs({ expiresAt: now - 5000 }, now), EXPIRE_RESUME_GRACE_MS)
})

// ── the tapped message has to be identifiable ─────────────────────────

Deno.test("translator: a callback query carries the message its keyboard is on", () => {
    const events = translateTelegramMessage({
        chat: { id: -100777, type: "supergroup" },
        from: { id: 42, username: "jeff" },
        callbackQuery: { id: "cbq-1", data: "q:q_x:0", message: { message_id: 4242, message_thread_id: 7 } },
    })
    assertEquals(events.length, 1)
    assertEquals(events[0].messageId, 4242)
    assertEquals(events[0].threadId, 7)
})

Deno.test("ask: a command's question routes its answer to the topic it was asked in", () => {
    // A custom command has no session identity of its own, but it knows which
    // topic it ran in — so asking needs no routing configuration.
    const core = coreWithSession()
    const action = ask(askEvent({
        questionId: "q_cmd",
        askedBy: { kind: "command", id: "agenda" },
        chatId: CHAT,
        threadId: 7,
    }), core)
    assertEquals(questionsOf(action).q_cmd.answerTo, "topic:life")
})
