// tests/listen-mode-test.js
//
// Listen mode: a session reads a chat but the daemon refuses its replies
// there. Covers the block itself, the one-turn unlock, the /listen
// command, and the my_chat_member → session spawn path.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, paths, makeCore, effectsOfType } from "./_helpers.js"

const { tempDir: _tempDir } = setupTempPaths("cbg-listen-mode-test-")

const COMMAND_CENTER = "-100222"
const GROUP = "-100333"

Deno.writeTextFileSync(
    paths.ACCESS_FILE,
    JSON.stringify({
        dmPolicy: "pairing",
        allowFrom: ["42"],
        groups: {},
        botCenterGroups: [],
        groupChats: [GROUP],
        pending: {},
        commandCenterChatId: COMMAND_CENTER,
    }, null, 2),
)

const { listenBlockReason, ensureGroupSession } = await import("../lib/listen-mode.js")
const channelHandle = (await import("../lib/event-handlers/claude-channel.js")).default
const memberHandle = (await import("../lib/event-handlers/bot-chat-member.js")).default
const stopHandle = (await import("../lib/event-handlers/claude-hook-stop.js")).default
const { translateTelegramMessage } = await import("../lib/pure/telegram-translator.js")

const hotCommandsMod = await import("../lib/hot-commands.js")
await hotCommandsMod.loadCommands(new URL("../commands", import.meta.url).pathname)
const listenCommand = hotCommandsMod.getHotCommands().get("listen")

// ── listenBlockReason ─────────────────────────────────────────────────

Deno.test("listenBlockReason: a session not in listen mode is never blocked", () => {
    assertEquals(listenBlockReason({ id: "s" }, GROUP), null)
    assertEquals(listenBlockReason(undefined, GROUP), null)
})

Deno.test("listenBlockReason: scoped listening blocks only the listened-to chat", () => {
    const session = { listenMode: true, listenChatId: GROUP }
    assert(listenBlockReason(session, GROUP))
    assertEquals(listenBlockReason(session, COMMAND_CENTER), null)
})

Deno.test("listenBlockReason: unscoped listening blocks everywhere", () => {
    const session = { listenMode: true }
    assert(listenBlockReason(session, GROUP))
    assert(listenBlockReason(session, COMMAND_CENTER))
})

Deno.test("listenBlockReason: an unlocked turn can speak", () => {
    const session = { listenMode: true, listenChatId: GROUP, listenUnlockedAt: 1000 }
    assertEquals(listenBlockReason(session, GROUP), null)
})

// ── enforcement in the reply tool ─────────────────────────────────────

function replyEvent(chatId) {
    return {
        type: "claude_channel_tool_request",
        toolName: "reply",
        sessionId: "group-sess",
        requestId: "r1",
        _conn: {},
        ts: 1000,
        args: { chat_id: chatId, text: "hello everyone" },
    }
}

function listeningCore() {
    return makeCore({
        chatState: {
            commandCenter: {},
            groupChatSessions: { [GROUP]: { sessionId: "group-sess", spawnedAt: 1 } },
        },
        chatSessions: {
            "group-sess": { id: "group-sess", _conn: {}, listenMode: true, listenChatId: GROUP },
        },
    })
}

Deno.test("reply: a listening session cannot post in the chat it listens to", () => {
    const action = channelHandle(replyEvent(GROUP), listeningCore())
    assertEquals(effectsOfType(action, "send_text_to_user").length, 0)
    const responses = effectsOfType(action, "ipc_respond")
    assertEquals(responses.length, 1)
    assertEquals(responses[0].message.result.isError, true)
    assert(responses[0].message.result.content[0].text.includes("listen mode"))
})

Deno.test("reply: a listening session can still talk to other chats", () => {
    const action = channelHandle(replyEvent(COMMAND_CENTER), listeningCore())
    assertEquals(effectsOfType(action, "send_text_to_user").length, 1)
})

Deno.test("reply: an unlocked listening session may answer", () => {
    const core = listeningCore()
    core.chatSessions["group-sess"].listenUnlockedAt = 999
    const action = channelHandle(replyEvent(GROUP), core)
    assertEquals(effectsOfType(action, "send_text_to_user").length, 1)
})

Deno.test("stop hook: ending a turn re-locks a listening session", () => {
    const core = listeningCore()
    core.chatSessions["group-sess"].listenUnlockedAt = 999
    const action = stopHandle({ type: "claude_hook_stop", sessionId: "group-sess", ts: 2000 }, core)
    assertEquals(action.stateChanges.chatSessions["group-sess"].listenUnlockedAt, undefined)
    assert("listenUnlockedAt" in action.stateChanges.chatSessions["group-sess"])
})

// ── /listen command ───────────────────────────────────────────────────

function commandEvent(text, chatId = GROUP) {
    return {
        type: "chat_user_message",
        ts: 1000,
        chatId,
        userId: "42",
        messageId: 5,
        chatType: "supergroup",
        text,
    }
}

Deno.test("/listen on in a group scopes the silence to that group", () => {
    const action = listenCommand(commandEvent("/listen on"), listeningCore())
    const patch = action.stateChanges.chatSessions["group-sess"]
    assertEquals(patch.listenMode, true)
    assertEquals(patch.listenChatId, GROUP)
})

Deno.test("/listen on outside a group silences the session everywhere", () => {
    const core = makeCore({
        chatState: { focusedSessionId: "sess-1", commandCenter: {} },
        chatSessions: { "sess-1": { id: "sess-1", _conn: {} } },
    })
    const event = { ...commandEvent("/listen on", "42"), chatType: "private" }
    const patch = listenCommand(event, core).stateChanges.chatSessions["sess-1"]
    assertEquals(patch.listenMode, true)
    assertEquals(patch.listenChatId, undefined)
})

Deno.test("/listen off clears the mode and its scope", () => {
    const action = listenCommand(commandEvent("/listen off"), listeningCore())
    const patch = action.stateChanges.chatSessions["group-sess"]
    assertEquals(patch.listenMode, false)
    assertEquals(patch.listenChatId, undefined)
})

Deno.test("/listen with no argument only reports, never mutates", () => {
    const action = listenCommand(commandEvent("/listen"), listeningCore())
    assertEquals(action.stateChanges, undefined)
    assertEquals(effectsOfType(action, "send_text_to_user").length, 1)
})

Deno.test("/listen ignores senders who are not allowlisted", () => {
    const event = { ...commandEvent("/listen off"), userId: "999" }
    assertEquals(listenCommand(event, listeningCore()).effects, [])
})

// ── joining a group ───────────────────────────────────────────────────

function membershipEvent(overrides = {}) {
    return {
        type: "bot_chat_member_updated",
        ts: 1000,
        chatId: GROUP,
        chatType: "supergroup",
        chatTitle: "Book Club",
        userId: "42",
        oldStatus: "left",
        newStatus: "member",
        ...overrides,
    }
}

Deno.test("joining a group spawns a session for it, in listen mode", () => {
    const action = memberHandle(membershipEvent(), makeCore({}))
    const spawns = effectsOfType(action, "spawn_dtach_session")
    assertEquals(spawns.length, 1)
    assertEquals(spawns[0].title, "Book Club")
    assertEquals(effectsOfType(action, "record_group_chat").length, 1)
    const session = action.stateChanges.chatSessions[spawns[0].sessionId]
    assertEquals(session.listenMode, true)
    assertEquals(session.listenChatId, GROUP)
})

Deno.test("being promoted to admin is not a join", () => {
    const event = membershipEvent({ oldStatus: "member", newStatus: "administrator" })
    assertEquals(memberHandle(event, makeCore({})), null)
})

Deno.test("leaving a group spawns nothing", () => {
    const event = membershipEvent({ oldStatus: "member", newStatus: "left" })
    assertEquals(memberHandle(event, makeCore({})), null)
})

Deno.test("a group that already has a live session is left alone", () => {
    const core = makeCore({
        chatState: { groupChatSessions: { [GROUP]: { sessionId: "group-sess", spawnedAt: 1 } } },
        chatSessions: { "group-sess": { id: "group-sess", _conn: {} } },
    })
    assertEquals(memberHandle(membershipEvent(), core), null)
})

Deno.test("a dead group session is not respawned on every message", () => {
    const core = makeCore({
        chatState: { groupChatSessions: { [GROUP]: { sessionId: "dead", spawnedAt: 1000 } } },
        chatSessions: { "dead": { id: "dead" } },
    })
    assertEquals(ensureGroupSession(core, GROUP, null, 1001).effects.length, 0)
    assertEquals(ensureGroupSession(core, GROUP, null, 1001 + 10 * 60 * 1000).effects.length, 1)
})

// ── translator ────────────────────────────────────────────────────────

Deno.test("translator: my_chat_member becomes a membership event", () => {
    const events = translateTelegramMessage({
        myChatMember: {
            chat: { id: -100333, type: "supergroup", title: "Book Club" },
            from: { id: 42 },
            old_chat_member: { status: "left" },
            new_chat_member: { status: "member" },
        },
    })
    assertEquals(events.length, 1)
    assertEquals(events[0].type, "bot_chat_member_updated")
    assertEquals(events[0].chatId, GROUP)
    assertEquals(events[0].chatTitle, "Book Club")
    assertEquals(events[0].newStatus, "member")
})
