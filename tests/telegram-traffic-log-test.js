// tests/telegram-traffic-log-test.js
//
// Unit tests for lib/telegram-traffic-log.js — the wire-layer jsonl
// trace of every Telegram message that crosses the bot.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, paths } from "./_helpers.js"

setupTempPaths("cbg-traffic-test-")

const { logTelegramTraffic, inboundEntryFromCtx } = await import("../lib/telegram-traffic-log.js")

function readLog() {
    const path = `${paths.STATE_DIR}/telegram-traffic.jsonl`
    let text
    try { text = Deno.readTextFileSync(path) } catch { return [] }
    return text.split("\n").filter(Boolean).map((l) => JSON.parse(l))
}

function clearLog() {
    const path = `${paths.STATE_DIR}/telegram-traffic.jsonl`
    try { Deno.removeSync(path) } catch { /* not present */ }
}

Deno.test("traffic-log: append writes one line per call", () => {
    clearLog()
    logTelegramTraffic({ direction: "out", kind: "text", chatId: "1", text: "hi" })
    logTelegramTraffic({ direction: "in", kind: "text", chatId: "1", text: "hello" })
    const lines = readLog()
    assertEquals(lines.length, 2)
    assertEquals(lines[0].direction, "out")
    assertEquals(lines[1].direction, "in")
})

Deno.test("traffic-log: stamps ts when missing", () => {
    clearLog()
    logTelegramTraffic({ direction: "out", kind: "text", chatId: "1", text: "hi" })
    const [entry] = readLog()
    assert(typeof entry.ts === "string")
    assert(entry.ts.includes("T"))
})

Deno.test("traffic-log: keeps caller-provided ts unchanged", () => {
    clearLog()
    const ts = "2026-05-01T00:00:00.000Z"
    logTelegramTraffic({ ts, direction: "out", kind: "text", chatId: "1", text: "hi" })
    const [entry] = readLog()
    assertEquals(entry.ts, ts)
})

Deno.test("inboundEntryFromCtx: text message", () => {
    const ctx = {
        message: {
            chat: { id: -123 },
            from: { id: 99, username: "jeff" },
            message_id: 42,
            message_thread_id: 7,
            text: "hello",
        },
    }
    const entry = inboundEntryFromCtx(ctx)
    assertEquals(entry.direction, "in")
    assertEquals(entry.kind, "text")
    assertEquals(entry.chatId, "-123")
    assertEquals(entry.threadId, 7)
    assertEquals(entry.messageId, "42")
    assertEquals(entry.userId, "99")
    assertEquals(entry.username, "jeff")
    assertEquals(entry.text, "hello")
})

Deno.test("inboundEntryFromCtx: photo attachment", () => {
    const ctx = {
        message: {
            chat: { id: -123 },
            from: { id: 99 },
            message_id: 42,
            photo: [{ file_id: "abc" }, { file_id: "def" }],
            caption: "look",
        },
    }
    const entry = inboundEntryFromCtx(ctx)
    assertEquals(entry.kind, "attachment")
    assertEquals(entry.attachment.kind, "photo")
    assertEquals(entry.attachment.count, 2)
    assertEquals(entry.text, "look")
})

Deno.test("inboundEntryFromCtx: document with metadata", () => {
    const ctx = {
        message: {
            chat: { id: -123 },
            from: { id: 99 },
            message_id: 42,
            document: { file_name: "x.pdf", mime_type: "application/pdf", file_size: 4096 },
        },
    }
    const entry = inboundEntryFromCtx(ctx)
    assertEquals(entry.attachment.kind, "document")
    assertEquals(entry.attachment.filename, "x.pdf")
    assertEquals(entry.attachment.size, 4096)
})

Deno.test("inboundEntryFromCtx: callback query", () => {
    const ctx = {
        callbackQuery: {
            from: { id: 99, username: "jeff" },
            data: "btn:foo",
            message: { chat: { id: -123 }, message_id: 42 },
        },
    }
    const entry = inboundEntryFromCtx(ctx)
    assertEquals(entry.kind, "callback")
    assertEquals(entry.userId, "99")
    assertEquals(entry.data, "btn:foo")
    assertEquals(entry.messageId, "42")
})

Deno.test("inboundEntryFromCtx: returns null when nothing to extract", () => {
    assertEquals(inboundEntryFromCtx({}), null)
    assertEquals(inboundEntryFromCtx(null), null)
})

Deno.test("inboundEntryFromCtx: replyToMessageId captured", () => {
    const ctx = {
        message: {
            chat: { id: -123 },
            from: { id: 99 },
            message_id: 42,
            text: "hi",
            reply_to_message: { message_id: 41 },
        },
    }
    const entry = inboundEntryFromCtx(ctx)
    assertEquals(entry.replyToMessageId, "41")
})
