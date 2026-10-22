// tests/access-group-buckets-test.js
//
// Groups fall into one of two buckets: BotCenter (full bot behavior) and
// GroupChats (silent unless addressed). Covers the classifier itself and
// the chat-user handler's enforcement of the silent bucket.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, paths, makeCore, effectsOfType, loadCommands, getHotCommands } from "./_helpers.js"

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

await loadCommands(new URL("../commands", import.meta.url).pathname)

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
// `binding` is what `/listen` writes for the group. Leaving listenMode
// off it is the default a group starts with: the bot answers the room.
// The session is deliberately seeded listenMode:true regardless, because
// that is the state a session spawned under the old default is in — the
// binding has to be able to overrule it without a respawn.
function coreWithGroupSession(binding = {}) {
    return makeCore({
        chatState: {
            focusedSessionId: "sess-1",
            groupChatSessions: { [RANDOM_GROUP]: { sessionId: "group-sess", spawnedAt: 1, ...binding } },
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
    assertEquals(action.stateChanges.chatSessions[spawns[0].sessionId].listenMode, false)
})

Deno.test("chat-user: unaddressed GroupChat text is delivered but posts nothing under /listen on", async () => {
    const action = await handle(groupEvent(), coreWithGroupSession({ listenMode: true }))
    assertEquals(effectsOfType(action, "deliver_channel_event").length, 1)
    assertEquals(effectsOfType(action, "send_text_to_user").length, 0)
    // The spinner policy keys off deliver_channel_event; noSpinner is what
    // keeps a "thinking" message out of a group expecting silence.
    assertEquals(action.noSpinner, true)
    assertEquals(action.stateChanges.chatSessions["group-sess"].listenUnlockedAt, undefined)
})

Deno.test("chat-user: by default an unaddressed GroupChat message is answered", async () => {
    const action = await handle(groupEvent(), coreWithGroupSession())
    assertEquals(effectsOfType(action, "deliver_channel_event").length, 1)
    // No spinner suppression: someone is waiting on an answer.
    assertEquals(action.noSpinner, undefined)
    assertEquals(action.stateChanges.chatSessions["group-sess"].listenUnlockedAt, groupEvent().ts)
})

Deno.test("chat-user: the group binding overrules a session left muzzled by an older default", async () => {
    // WideBird's exact shape: spawned listenMode:true, binding silent on
    // the subject. Before this the binding only applied when the session
    // flag was undefined, so such a session could never be un-muzzled.
    const action = await handle(groupEvent(), coreWithGroupSession())
    const patch = action.stateChanges.chatSessions["group-sess"]
    // Deleted, not corrected: the binding is the only copy, so there is
    // no second field left reading `true` to mislead the next debugger.
    assert("listenMode" in patch)
    assertEquals(patch.listenMode, undefined)
    assertEquals(patch.listenChatId, RANDOM_GROUP)
    assertEquals(action.noSpinner, undefined)
})

Deno.test("chat-user: /listen on in the binding re-muzzles a session that was answering", async () => {
    const core = coreWithGroupSession({ listenMode: true })
    core.chatSessions["group-sess"].listenMode = false
    const action = await handle(groupEvent(), core)
    assertEquals(action.stateChanges.chatSessions["group-sess"].listenMode, undefined)
    assertEquals(action.noSpinner, true)
})

Deno.test("chat-user: an unallowlisted sender's slash command never runs, and never reaches the session", async () => {
    const action = await handle(groupEvent({ text: "/help", userId: "999" }), coreWithGroupSession())
    assertEquals(effectsOfType(action, "send_text_to_user").length, 0)
    assertEquals(effectsOfType(action, "deliver_channel_event").length, 0)
})

Deno.test("chat-user: an allowlisted sender's slash command still dispatches in a GroupChat", async () => {
    const action = await handle(groupEvent({ text: "/listen" }), coreWithGroupSession({ listenMode: true }))
    assertEquals(effectsOfType(action, "deliver_channel_event").length, 0)
    const sent = effectsOfType(action, "send_text_to_user")
    assertEquals(sent.length, 1)
    // "Unknown command" is also one send_text_to_user, and that is what a
    // test gets when it loads commands into a registry the handler can't
    // see (see tests/_helpers.js) — so name what the answer must be.
    assert(sent[0].text.includes("listening"))
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
    // The spawn's own topic handoff, then the message that summoned it.
    assertEquals(queue.length, 2)
    assertEquals(queue[0].meta.source, "group-listen-context")
    assertEquals(queue.map(q => q.targetSessionId), [sessionId, sessionId])
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

// ── commands in a GroupChat are allowlist-only ────────────────────────

Deno.test("chat-user: a stranger's slash command in a GroupChat is never executed", async () => {
    const event = groupEvent({ text: "/listen", userId: "999" })
    const action = await handle(event, coreWithGroupSession())
    // Nothing runs, nothing is posted back, and nothing reaches the model.
    assertEquals(effectsOfType(action, "send_text_to_user").length, 0)
    assertEquals(effectsOfType(action, "deliver_channel_event").length, 0)
})

Deno.test("chat-user: a stranger cannot /refresh a group's session", async () => {
    const event = groupEvent({ text: "/refresh", userId: "999" })
    const action = await handle(event, coreWithGroupSession())
    assertEquals(effectsOfType(action, "send_text_to_user").length, 0)
    assertEquals(effectsOfType(action, "spawn_dtach_session").length, 0)
    assertEquals(action.stateChanges.chatState?.groupChatSessions, undefined)
})

Deno.test("chat-user: a stranger cannot /peek at a group's session", async () => {
    const event = groupEvent({ text: "/peek", userId: "999" })
    const action = await handle(event, coreWithGroupSession())
    assertEquals(effectsOfType(action, "send_text_to_user").length, 0)
})

Deno.test("chat-user: a stranger's chatter never reaches the group's session", async () => {
    const action = await handle(groupEvent({ userId: "999" }), coreWithGroupSession())
    assertEquals(effectsOfType(action, "deliver_channel_event").length, 0)
    assertEquals(effectsOfType(action, "send_text_to_user").length, 0)
})

Deno.test("chat-user: a stranger cannot summon a session by @mentioning the bot", async () => {
    const event = { ...mentionEvent(), userId: "999" }
    const action = await handle(event, coreWithSession())
    assertEquals(effectsOfType(action, "spawn_dtach_session").length, 0)
    assertEquals(effectsOfType(action, "deliver_channel_event").length, 0)
})

Deno.test("chat-user: an allowlisted member's chatter still reaches the session", async () => {
    const action = await handle(groupEvent(), coreWithGroupSession())
    assertEquals(effectsOfType(action, "deliver_channel_event").length, 1)
})

// ── attachments in a GroupChat ─────────────────────────────────────────
//
// The group bucket is claimed before chat-user's attachment handling, so
// a photo or PDF posted in a group used to arrive as its caption alone.

function documentEvent(overrides = {}) {
    return groupEvent({
        text: "(document: notes.pdf)",
        attachment: { kind: "document", fileId: "FID-1", fileUniqueId: "UID-1", name: "notes.pdf" },
        ...overrides,
    })
}

Deno.test("chat-user: a GroupChat attachment is downloaded before it is delivered", async () => {
    const action = await handle(documentEvent(), coreWithGroupSession())
    const downloads = effectsOfType(action, "download_telegram_file")
    assertEquals(downloads.length, 1)
    assertEquals(downloads[0].fileId, "FID-1")
    assertEquals(downloads[0].followUpEvent._downloaded, true)
    // Nothing reaches the session on the first pass — there's no file yet.
    assertEquals(effectsOfType(action, "deliver_channel_event").length, 0)
})

Deno.test("chat-user: a downloaded GroupChat attachment carries its path and file id", async () => {
    const event = documentEvent({ _downloaded: true, imagePath: "/tmp/notes.pdf" })
    const action = await handle(event, coreWithGroupSession())
    const delivered = effectsOfType(action, "deliver_channel_event")
    assertEquals(delivered.length, 1)
    assert(delivered[0].content.includes("/tmp/notes.pdf"))
    assert(delivered[0].content.includes("notes.pdf"))
    // download_attachment needs the file id; Read needs the path.
    assertEquals(delivered[0].meta.attachment_file_id, "FID-1")
    assertEquals(delivered[0].meta.image_path, "/tmp/notes.pdf")
})

Deno.test("chat-user: a caption starting with a slash is not read as a command", async () => {
    // "/notes …" would otherwise dispatch as a command and, failing that,
    // route to the FOCUSED session instead of the group's own.
    const event = documentEvent({ text: "/notes for later" })
    const action = await handle(event, coreWithGroupSession())
    assertEquals(effectsOfType(action, "download_telegram_file").length, 1)
    assertEquals(effectsOfType(action, "send_text_to_user").length, 0)
})

// ── "answer everything here" is a setting on the GROUP ─────────────────

function coreWithTalkingGroup() {
    return makeCore({
        chatState: {
            commandCenter: {},
            focusedSessionId: "sess-1",
            groupChatSessions: {
                [RANDOM_GROUP]: { sessionId: "group-sess", spawnedAt: 1, listenMode: false },
            },
        },
        chatSessions: {
            "sess-1": { id: "sess-1", _conn: {} },
            // listenMode undefined: the group's setting is what decides.
            "group-sess": { id: "group-sess", _conn: {} },
        },
    })
}

Deno.test("chat-user: with listen mode off for the group, an unaddressed message is answered", async () => {
    const action = await handle(groupEvent(), coreWithTalkingGroup())
    assertEquals(effectsOfType(action, "deliver_channel_event").length, 1)
    const patch = action.stateChanges.chatSessions["group-sess"]
    // A spinner and a reply obligation — the two things silence suppresses.
    assertEquals(action.noSpinner, undefined)
    assertEquals(patch.pendingNudgeAction, "askAgentToSendChatMessage")
})

Deno.test("chat-user: /listen off in a group stores the setting on the binding", async () => {
    const action = await handle(groupEvent({ text: "/listen off" }), coreWithGroupSession())
    const binding = action.stateChanges.chatState.groupChatSessions[RANDOM_GROUP]
    assertEquals(binding.listenMode, false)
    // A partial binding patch must not wipe the rest of it (deep merge).
    assertEquals(Object.keys(binding), ["listenMode"])
    assertEquals(action.stateChanges.chatSessions["group-sess"].listenMode, undefined)
})
