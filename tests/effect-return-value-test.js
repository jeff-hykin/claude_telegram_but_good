// tests/effect-return-value-test.js
//
// Tests for the effect-return-value pathway: effects MAY return
// `{ stateChanges }` to describe state patches based on information
// only available after the effect's async side effect resolves
// (e.g. a Grammy message_id captured after `bot.api.sendMessage`).
// onEvent merges each returned patch into core before running the
// next effect.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, makeCore } from "./_helpers.js"

setupTempPaths("cbg-effect-return-test-")

const { sendTextMessageToUser, sendFileToUser } = await import("../lib/effects/telegram-outbound.js")
const { buildOutboundMessagePatch } = await import("../lib/effects/telegram-state.js")

// Fake bot that mimics the abstract Bot class surface that
// telegram-outbound.js now calls through. Returns the same message-id
// shape the real adapter does: `{ messageId }`.
function fakeBot(startId = 9000) {
    let next = startId
    const calls = []
    const supports = {
        reactions: true, inlineButtons: true, htmlFormatting: true,
        markdownFormatting: false, fileDownload: true,
    }
    return {
        calls,
        supports,
        async sendText(chatId, text, options) {
            const id = next++
            calls.push({ method: "sendText", chatId, text, options, returned: id })
            return { messageId: String(id) }
        },
        async sendFile(chatId, filePath, options) {
            const id = next++
            calls.push({ method: "sendFile", chatId, filePath, options, returned: id })
            return { messageId: String(id) }
        },
        async editText(chatId, messageId, text, options) {
            calls.push({ method: "editText", chatId, messageId, text, options })
        },
        async react() { return true },
        async answerCallback() { return true },
        async downloadFile() { return true },
    }
}

// ── sendTextMessageToUser returns a stateChanges patch ─────────────

Deno.test("effect-return: sendTextMessageToUser returns stateChanges for recorded outbound", async () => {
    const bot = fakeBot(9000)
    const core = makeCore({ bot })
    const result = await sendTextMessageToUser({
        chatId: "42",
        text: "hello world",
        recordAs: { from: "agent", kind: "regular", sessionId: "sess-1" },
    }, core)
    assert(result, "expected sendTextMessageToUser to return a result")
    const patch = result.stateChanges.specialData.telegramMessagesByChatId["42"]
    assertEquals(Object.keys(patch).length, 1)
    const id = Object.keys(patch)[0]
    assertEquals(id, "9000")
    assertEquals(patch["9000"].from, "agent")
    assertEquals(patch["9000"].sessionId, "sess-1")
})

Deno.test("effect-return: chunked text produces one record entry per chunk", async () => {
    const bot = fakeBot(9000)
    const core = makeCore({ bot })
    const long = "x".repeat(10000)
    const result = await sendTextMessageToUser({
        chatId: "42",
        text: long,
        recordAs: { from: "agent", kind: "regular", sessionId: "sess-1" },
    }, core)
    assert(result)
    const patch = result.stateChanges.specialData.telegramMessagesByChatId["42"]
    // At least three chunks → three sendMessage calls → three recorded ids.
    assert(Object.keys(patch).length >= 3)
    const ids = Object.keys(patch).map(Number).sort((a, b) => a - b)
    // Ids start at 9000 and increment monotonically.
    assertEquals(ids[0], 9000)
    assertEquals(ids[ids.length - 1], 9000 + ids.length - 1)
})

Deno.test("effect-return: sendTextMessageToUser with no recordAs returns undefined", async () => {
    const bot = fakeBot(9000)
    const core = makeCore({ bot })
    const result = await sendTextMessageToUser({
        chatId: "42",
        text: "no record requested",
    }, core)
    assertEquals(result, undefined)
})

Deno.test("effect-return: sendTextMessageToUser with no bot returns undefined", async () => {
    const core = makeCore({ bot: null })
    const result = await sendTextMessageToUser({
        chatId: "42",
        text: "hi",
        recordAs: { from: "agent", kind: "regular" },
    }, core)
    assertEquals(result, undefined)
})

Deno.test("effect-return: sendFileToUser returns stateChanges after a successful send", async () => {
    // Build a real tempfile outside STATE_DIR so assertSendable passes.
    const tmp = Deno.makeTempFileSync({ suffix: ".txt" })
    Deno.writeTextFileSync(tmp, "hello file")
    try {
        const bot = fakeBot(7000)
        const core = makeCore({ bot })
        const result = await sendFileToUser({
            chatId: "42",
            filePath: tmp,
            filename: "hello.txt",
            caption: "file caption",
            recordAs: { from: "agent", kind: "regular", sessionId: "sess-1" },
        }, core)
        assert(result, "expected sendFileToUser to return a result")
        const patch = result.stateChanges.specialData.telegramMessagesByChatId["42"]
        const id = Object.keys(patch)[0]
        assertEquals(id, "7000")
        assertEquals(patch["7000"].from, "agent")
    } finally {
        try { Deno.removeSync(tmp) } catch (e) { /* best-effort */ }
    }
})

// ── buildOutboundMessagePatch is pure ───────────────────────────────

Deno.test("buildOutboundMessagePatch: single entry → one record in the patch", () => {
    const core = makeCore({
        specialData: { telegramMessagesByChatId: {} },
    })
    const patch = buildOutboundMessagePatch(core, [
        { id: "1", chatId: "42", from: "agent", kind: "regular", ts: 1, text: "a" },
    ])
    assertEquals(patch.specialData.telegramMessagesByChatId["42"]["1"].text, "a")
})

Deno.test("buildOutboundMessagePatch: multiple entries for the same chat share a single patch", () => {
    const core = makeCore({
        specialData: { telegramMessagesByChatId: { "42": {} } },
    })
    const patch = buildOutboundMessagePatch(core, [
        { id: "1", chatId: "42", from: "agent", kind: "regular", ts: 1, text: "a" },
        { id: "2", chatId: "42", from: "agent", kind: "regular", ts: 2, text: "b" },
        { id: "3", chatId: "42", from: "agent", kind: "regular", ts: 3, text: "c" },
    ])
    const byChat = patch.specialData.telegramMessagesByChatId["42"]
    assertEquals(Object.keys(byChat).length, 3)
    assertEquals(byChat["1"].text, "a")
    assertEquals(byChat["3"].text, "c")
})

Deno.test("buildOutboundMessagePatch: entries across different chats keep separate maps", () => {
    const core = makeCore({ specialData: { telegramMessagesByChatId: {} } })
    const patch = buildOutboundMessagePatch(core, [
        { id: "1", chatId: "42", from: "agent", kind: "regular", ts: 1, text: "a" },
        { id: "5", chatId: "99", from: "agent", kind: "regular", ts: 2, text: "b" },
    ])
    assertEquals(Object.keys(patch.specialData.telegramMessagesByChatId).length, 2)
    assertEquals(patch.specialData.telegramMessagesByChatId["42"]["1"].text, "a")
    assertEquals(patch.specialData.telegramMessagesByChatId["99"]["5"].text, "b")
})

Deno.test("buildOutboundMessagePatch: empty input returns null (caller can skip)", () => {
    const core = makeCore()
    assertEquals(buildOutboundMessagePatch(core, []), null)
    assertEquals(buildOutboundMessagePatch(core, null), null)
})

Deno.test("buildOutboundMessagePatch: eviction beyond the cap emits undefined delete sentinels", () => {
    // Pre-fill a chat with 100 entries (the MAX_MESSAGES_PER_CHAT cap),
    // then push one more and verify the oldest ts is marked undefined.
    const existing = {}
    for (let i = 0; i < 100; i++) {
        existing[String(i)] = { id: String(i), ts: i, text: `m${i}` }
    }
    const core = makeCore({
        specialData: { telegramMessagesByChatId: { "42": existing } },
    })
    const patch = buildOutboundMessagePatch(core, [
        { id: "new", chatId: "42", from: "agent", kind: "regular", ts: 1000, text: "new" },
    ])
    const byChat = patch.specialData.telegramMessagesByChatId["42"]
    assertEquals(byChat["new"].text, "new")
    assertEquals(byChat["0"], undefined, "oldest entry should be evicted as undefined")
    assert("0" in byChat, "eviction must be an explicit undefined delete sentinel, not missing")
})
