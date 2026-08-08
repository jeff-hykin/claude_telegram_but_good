// tests/access-group-buckets-test.js
//
// Groups fall into one of two buckets: BotCenter (full bot behavior) and
// GroupChats (silent unless addressed). Covers the classifier itself and
// the chat-user handler's enforcement of the silent bucket.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, paths, makeCore, effectsOfType } from "./_helpers.js"

const { tempDir: _tempDir } = setupTempPaths("cbg-group-buckets-test-")

const BOT_CENTER = "-100111"
const COMMAND_CENTER = "-100222"
const RANDOM_GROUP = "-100333"

function writeBucketAccess() {
    Deno.writeTextFileSync(
        paths.ACCESS_FILE,
        JSON.stringify({
            dmPolicy: "pairing",
            allowFrom: ["42"],
            groups: {},
            botCenterGroups: [BOT_CENTER],
            groupChats: [RANDOM_GROUP],
            pending: {},
            commandCenterChatId: COMMAND_CENTER,
        }, null, 2),
    )
}
writeBucketAccess()

const access = await import("../lib/access.js")
const handle = (await import("../lib/event-handlers/chat-user.js")).default

const hotCommandsMod = await import("../lib/hot-commands.js")
await hotCommandsMod.loadCommands(new URL("../commands", import.meta.url).pathname)

function groupEvent(overrides = {}) {
    const text = overrides.text ?? "what a nice day"
    return {
        type: "chat_user_message",
        ts: 1_000_000,
        chatId: RANDOM_GROUP,
        userId: "42",
        username: "alice",
        messageId: 7,
        replyToMessageId: null,
        replyToText: null,
        attachment: null,
        chatType: "supergroup",
        _ctx: { me: { username: "MrClank" }, message: { text } },
        ...overrides,
        text,
    }
}

/** An event whose text contains a real Telegram @mention entity. */
function mentionEvent(chatId = RANDOM_GROUP) {
    const text = "@MrClank what do you think?"
    return groupEvent({
        chatId,
        text,
        _ctx: {
            me: { username: "MrClank" },
            message: {
                text,
                entities: [{ type: "mention", offset: 0, length: "@MrClank".length }],
            },
        },
    })
}

function coreWithSession() {
    return makeCore({
        chatState: { focusedSessionId: "sess-1" },
        chatSessions: { "sess-1": { id: "sess-1", _conn: {} } },
    })
}

/** A core where the random group already has its own listening session. */
function coreWithGroupSession() {
    return makeCore({
        chatState: {
            focusedSessionId: "sess-1",
            groupChatSessions: { [RANDOM_GROUP]: { sessionId: "group-sess", spawnedAt: 1 } },
        },
        chatSessions: {
            "sess-1": { id: "sess-1", _conn: {} },
            "group-sess": { id: "group-sess", _conn: {}, listenMode: true, listenChatId: RANDOM_GROUP },
        },
    })
}

// ── classifier ────────────────────────────────────────────────────────

Deno.test("classifyGroup: unlisted groups default to GroupChats", () => {
    const a = access.readAccessFile()
    assertEquals(access.classifyGroup("-100999", a), "groupChat")
    assertEquals(access.classifyGroup(RANDOM_GROUP, a), "groupChat")
})

Deno.test("classifyGroup: explicit BotCenter members and the command center", () => {
    const a = access.readAccessFile()
    assertEquals(access.classifyGroup(BOT_CENTER, a), "botCenter")
    assertEquals(access.classifyGroup(COMMAND_CENTER, a), "botCenter")
})

Deno.test("classifyGroup: numeric chat ids match the string list", () => {
    const a = access.readAccessFile()
    assertEquals(access.classifyGroup(Number(BOT_CENTER), a), "botCenter")
})

// ── isBotMentioned ────────────────────────────────────────────────────

Deno.test("isBotMentioned: @username entity counts, plain text does not", () => {
    const a = access.readAccessFile()
    assert(access.isBotMentioned(mentionEvent(), a))
    assert(!access.isBotMentioned(groupEvent(), a))
})

Deno.test("isBotMentioned: replying to the bot counts as addressing it", () => {
    const a = access.readAccessFile()
    const event = groupEvent()
    event._ctx.message.reply_to_message = { from: { username: "MrClank" } }
    assert(access.isBotMentioned(event, a))
})

Deno.test("isBotMentioned: fails closed when the bot username is unknown", () => {
    const a = access.readAccessFile()
    const event = mentionEvent()
    event._ctx.me = {}
    assert(!access.isBotMentioned(event, a))
})

// ── chat-user enforcement ─────────────────────────────────────────────

Deno.test("chat-user: a GroupChat with no session of its own spawns one", async () => {
    const action = await handle(groupEvent(), coreWithSession())
    const spawns = effectsOfType(action, "spawn_dtach_session")
    assertEquals(spawns.length, 1)
    assertEquals(effectsOfType(action, "send_text_to_user").length, 0)
    const bound = action.stateChanges.chatState.groupChatSessions[RANDOM_GROUP]
    assertEquals(bound.sessionId, spawns[0].sessionId)
    assertEquals(action.stateChanges.chatSessions[spawns[0].sessionId].listenMode, true)
})

Deno.test("chat-user: unaddressed GroupChat text is delivered but posts nothing", async () => {
    const action = await handle(groupEvent(), coreWithGroupSession())
    assertEquals(effectsOfType(action, "deliver_channel_event").length, 1)
    assertEquals(effectsOfType(action, "send_text_to_user").length, 0)
    // The spinner policy keys off deliver_channel_event; noSpinner is what
    // keeps a "thinking" message out of a group expecting silence.
    assertEquals(action.noSpinner, true)
    assertEquals(action.stateChanges.chatSessions["group-sess"].listenUnlockedAt, undefined)
})

Deno.test("chat-user: an unallowlisted sender's slash command is just more chatter", async () => {
    const action = await handle(groupEvent({ text: "/help", userId: "999" }), coreWithGroupSession())
    assertEquals(effectsOfType(action, "send_text_to_user").length, 0)
    assertEquals(effectsOfType(action, "deliver_channel_event").length, 1)
})

Deno.test("chat-user: an allowlisted sender's slash command still dispatches in a GroupChat", async () => {
    const action = await handle(groupEvent({ text: "/listen" }), coreWithGroupSession())
    assertEquals(effectsOfType(action, "deliver_channel_event").length, 0)
    assertEquals(effectsOfType(action, "send_text_to_user").length, 1)
})

Deno.test("chat-user: mentioning the bot unlocks the group's session for the turn", async () => {
    const action = await handle(mentionEvent(), coreWithGroupSession())
    assertEquals(effectsOfType(action, "deliver_channel_event").length, 1)
    assertEquals(action.stateChanges.chatSessions["group-sess"].listenUnlockedAt, 1_000_000)
    assertEquals(action.noSpinner, undefined)
})

Deno.test("chat-user: a mention while the session is still starting is queued, silently", async () => {
    const action = await handle(mentionEvent(), coreWithSession())
    const sessionId = effectsOfType(action, "spawn_dtach_session")[0].sessionId
    const queue = action.stateChanges.chatState.messageQueue
    assertEquals(queue.length, 1)
    assertEquals(queue[0].targetSessionId, sessionId)
    assertEquals(effectsOfType(action, "send_text_to_user").length, 0)
    // It must be able to answer the message that summoned it.
    assertEquals(action.stateChanges.chatSessions[sessionId].listenUnlockedAt, 1_000_000)
})

Deno.test("chat-user: BotCenter groups need no mention", async () => {
    const action = await handle(groupEvent({ chatId: BOT_CENTER }), coreWithSession())
    assertEquals(effectsOfType(action, "deliver_channel_event").length, 1)
})

Deno.test("chat-user: a newly seen group is recorded in the GroupChats list", async () => {
    writeBucketAccess()
    const unseen = "-100444"
    const action = await handle(groupEvent({ chatId: unseen }), coreWithSession())
    const records = effectsOfType(action, "record_group_chat")
    assertEquals(records.length, 1)
    assertEquals(records[0].chatId, unseen)

    const accessEffect = await import("../lib/effects/access-effect.js")
    accessEffect.recordGroupChat(records[0], null)
    assert(access.readAccessFile().groupChats.includes(unseen))

    // Second sighting is already on the list — no repeat write.
    const again = await handle(groupEvent({ chatId: unseen }), coreWithSession())
    assertEquals(effectsOfType(again, "record_group_chat").length, 0)
})
