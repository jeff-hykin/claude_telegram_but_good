// tests/effect-channel-event-test.js
//
// Unit tests for lib/effects/channel-event.js — covers the periodic
// per-topic memory-file reminder.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, makeCore } from "./_helpers.js"

setupTempPaths("cbg-channel-test-")

const { deliverChannelEvent } = await import("../lib/effects/channel-event.js")

function recordingConn() {
    const writes = []
    return {
        write(bytes) { writes.push(new TextDecoder().decode(bytes)); return Promise.resolve() },
        close() {},
        read() { return Promise.resolve(null) },
        get writes() { return writes },
    }
}

function makeBoundCore({ topicName, lastReminderAt = 0 } = {}) {
    const conn = recordingConn()
    return {
        core: makeCore({
            chatState: {
                commandCenter: {
                    topicMap: { S1: 7 },
                    topicNames: { 7: topicName },
                    memoryReminderLastAt: { [topicName]: lastReminderAt },
                },
            },
            chatSessions: { S1: { id: "S1", _conn: conn } },
        }),
        conn,
    }
}

Deno.test("channel-event: appends memory reminder when interval elapsed", async () => {
    const { core, conn } = makeBoundCore({ topicName: "mytopic", lastReminderAt: 0 })
    const ret = await deliverChannelEvent(
        { type: "deliver_channel_event", sessionId: "S1", content: "hello", meta: {} },
        core,
    )
    assertEquals(conn.writes.length, 1)
    const wire = JSON.parse(conn.writes[0].replace(/\n$/, ""))
    assert(wire.content.includes("hello"))
    assert(wire.content.includes("memory.md"))
    assert(wire.content.includes("system-reminder"))
    // returns a state patch updating memoryReminderLastAt[topic]
    const updatedAt = ret.stateChanges.chatState.commandCenter.memoryReminderLastAt.mytopic
    assert(typeof updatedAt === "number" && updatedAt > 0)
})

Deno.test("channel-event: skips memory reminder if interval not elapsed", async () => {
    const justNow = Date.now() - 60_000  // 1 min ago, well under 1 hour
    const { core, conn } = makeBoundCore({ topicName: "mytopic", lastReminderAt: justNow })
    const ret = await deliverChannelEvent(
        { type: "deliver_channel_event", sessionId: "S1", content: "hello", meta: {} },
        core,
    )
    const wire = JSON.parse(conn.writes[0].replace(/\n$/, ""))
    assertEquals(wire.content, "hello")  // untouched
    assertEquals(ret, undefined)
})

Deno.test("channel-event: skips memory reminder for unbound (no-topic) session", async () => {
    const conn = recordingConn()
    const core = makeCore({
        chatState: { commandCenter: { topicMap: {}, topicNames: {} } },
        chatSessions: { Lone: { id: "Lone", _conn: conn } },
    })
    const ret = await deliverChannelEvent(
        { type: "deliver_channel_event", sessionId: "Lone", content: "hi", meta: {} },
        core,
    )
    const wire = JSON.parse(conn.writes[0].replace(/\n$/, ""))
    assertEquals(wire.content, "hi")
    assertEquals(ret, undefined)
})

Deno.test("channel-event: still writes inbox + returns patch even when session has no _conn", async () => {
    const core = makeCore({
        chatState: {
            commandCenter: {
                topicMap: { S1: 7 },
                topicNames: { 7: "mytopic" },
                memoryReminderLastAt: { mytopic: 0 },
            },
        },
        chatSessions: { S1: { id: "S1" } },  // no _conn
    })
    const ret = await deliverChannelEvent(
        { type: "deliver_channel_event", sessionId: "S1", content: "x", meta: {} },
        core,
    )
    assert(ret.stateChanges.chatState.commandCenter.memoryReminderLastAt.mytopic > 0)
})

// Regression: Claude Code's MCP client validates `notifications/claude/channel`
// params.meta with a Zod schema requiring every value to be a string. Boolean
// or null values caused a ZodError → STDIO transport closed → SIGTERM to the
// shim ~2s after the first cli_tell channel event ("QualifiedBandicoot bug").
// deliverChannelEvent must strip non-allowlisted keys (fromCli, fromInbox,
// source, etc.) and stringify all values it does forward.
Deno.test("channel-event: strips non-string meta keys before IPC write (QB regression)", async () => {
    const conn = recordingConn()
    const core = makeCore({
        chatState: { commandCenter: { topicMap: {}, topicNames: {} } },
        chatSessions: { S1: { id: "S1", _conn: conn } },
    })
    await deliverChannelEvent(
        {
            type: "deliver_channel_event",
            sessionId: "S1",
            content: "hi",
            meta: {
                source: "cli_tell",
                fromCli: true,         // boolean — Zod fails
                fromInbox: null,       // null    — Zod fails
                chat_id: "cbg-internal",
                message_id: "m-1",
                user: "cli",
                user_id: "cbg",
                ts: "2026-04-26T00:00:00.000Z",
            },
        },
        core,
    )
    const wire = JSON.parse(conn.writes[0].replace(/\n$/, ""))
    const sentMeta = wire.meta
    // Disallowed keys must not be present on the wire
    assertEquals(sentMeta.fromCli, undefined)
    assertEquals(sentMeta.fromInbox, undefined)
    assertEquals(sentMeta.source, undefined)
    // Allowed keys must be present and all string-typed
    for (const k of ["chat_id", "message_id", "user", "user_id", "ts"]) {
        assert(typeof sentMeta[k] === "string", `${k} should be string, got ${typeof sentMeta[k]}`)
    }
})

Deno.test("channel-event: missing meta fields get string fallbacks (QB regression)", async () => {
    const conn = recordingConn()
    const core = makeCore({
        chatState: { commandCenter: { topicMap: {}, topicNames: {} } },
        chatSessions: { S1: { id: "S1", _conn: conn } },
    })
    await deliverChannelEvent(
        { type: "deliver_channel_event", sessionId: "S1", content: "hi", meta: {} },
        core,
    )
    const wire = JSON.parse(conn.writes[0].replace(/\n$/, ""))
    for (const k of ["chat_id", "message_id", "user", "user_id", "ts"]) {
        assert(typeof wire.meta[k] === "string" && wire.meta[k].length > 0,
            `${k} should be non-empty string, got ${JSON.stringify(wire.meta[k])}`)
    }
})

Deno.test("channel-event: stringifies attachment_size when present (QB regression)", async () => {
    const conn = recordingConn()
    const core = makeCore({
        chatState: { commandCenter: { topicMap: {}, topicNames: {} } },
        chatSessions: { S1: { id: "S1", _conn: conn } },
    })
    await deliverChannelEvent(
        {
            type: "deliver_channel_event",
            sessionId: "S1",
            content: "hi",
            meta: {
                chat_id: "1", message_id: "1", user: "u", user_id: "1", ts: "t",
                attachment_kind: "photo",
                attachment_file_id: "F123",
                attachment_size: 4096,        // number — Zod expects string
            },
        },
        core,
    )
    const wire = JSON.parse(conn.writes[0].replace(/\n$/, ""))
    assertEquals(typeof wire.meta.attachment_size, "string")
    assertEquals(wire.meta.attachment_size, "4096")
    assertEquals(wire.meta.attachment_kind, "photo")
})
