// tests/listen-mode-test.js
//
// Listen mode: a session reads a chat but the daemon refuses its replies
// there. Covers the block itself, the one-turn unlock, the /listen
// command, and the my_chat_member → session spawn path.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, paths, makeCore, effectsOfType, loadCommands, getHotCommands } from "./_helpers.js"

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

const { listenBlockReason, listensToChat, heldReplyTarget, ensureGroupSession } = await import("../lib/listen-mode.js")
const channelHandle = (await import("../lib/event-handlers/claude-channel.js")).default
const memberHandle = (await import("../lib/event-handlers/bot-chat-member.js")).default
const stopHandle = (await import("../lib/event-handlers/claude-hook-stop.js")).default
const nudgeHandle = (await import("../lib/event-handlers/stop-nudge-fire.js")).default
const { translateTelegramMessage } = await import("../lib/pure/telegram-translator.js")

await loadCommands(new URL("../commands", import.meta.url).pathname)
const listenCommand = getHotCommands().get("listen")

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

// A group that really is being listened to. `listenMode: true` on the
// BINDING is what makes that so — the session flag alone is only a cache
// of it, and since v232 a binding that says nothing means "answer".
function listeningCore() {
    return makeCore({
        chatState: {
            commandCenter: {},
            groupChatSessions: { [GROUP]: { sessionId: "group-sess", spawnedAt: 1, listenMode: true } },
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

Deno.test("/listen on in a group writes the binding and deletes the session's copy", () => {
    const action = listenCommand(commandEvent("/listen on"), listeningCore())
    assertEquals(action.stateChanges.chatState.groupChatSessions[GROUP].listenMode, true)
    const patch = action.stateChanges.chatSessions["group-sess"]
    // Present-but-undefined is what mergeSessionData treats as a delete:
    // in a group there must be exactly one copy of the setting.
    assert("listenMode" in patch)
    assertEquals(patch.listenMode, undefined)
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

Deno.test("/listen off in a group writes the binding and deletes the session's copy", () => {
    const action = listenCommand(commandEvent("/listen off"), listeningCore())
    assertEquals(action.stateChanges.chatState.groupChatSessions[GROUP].listenMode, false)
    const patch = action.stateChanges.chatSessions["group-sess"]
    assert("listenMode" in patch)
    assertEquals(patch.listenMode, undefined)
})

Deno.test("/listen off outside a group still sets the session's own flag", () => {
    const core = makeCore({
        chatState: { focusedSessionId: "sess-1", commandCenter: {} },
        chatSessions: { "sess-1": { id: "sess-1", _conn: {}, listenMode: true } },
    })
    const event = { ...commandEvent("/listen off", "42"), chatType: "private" }
    const patch = listenCommand(event, core).stateChanges.chatSessions["sess-1"]
    assertEquals(patch.listenMode, false)
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

Deno.test("joining a group spawns a session that answers the room", () => {
    const action = memberHandle(membershipEvent(), makeCore({}))
    const spawns = effectsOfType(action, "spawn_dtach_session")
    assertEquals(spawns.length, 1)
    assertEquals(spawns[0].title, "Book Club")
    assertEquals(effectsOfType(action, "record_group_chat").length, 1)
    const session = action.stateChanges.chatSessions[spawns[0].sessionId]
    assertEquals(session.listenMode, false)
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

// ── the unlock must outlive a Stop that owes a reply ───────────────────
//
// An addressed message can land while the previous turn is still
// finishing. The unlock is granted immediately, and the OLD turn's Stop
// used to wipe it — so the reply the nudge timer then demanded was the
// one reply the gate refused.

function owedReplyCore(chatId = GROUP) {
    const core = listeningCore()
    Object.assign(core.chatSessions["group-sess"], {
        listenUnlockedAt: 999,
        pendingNudgeAction: "askAgentToSendChatMessage",
        lastInbound: { chatId, messageId: "1", ts: 999, text: "@MrClank hi" },
    })
    return core
}

Deno.test("stop hook: a Stop that still owes a reply keeps the unlock", () => {
    const action = stopHandle({ type: "claude_hook_stop", sessionId: "group-sess", ts: 2000 }, owedReplyCore())
    const patch = action.stateChanges.chatSessions["group-sess"]
    // Absent from the patch entirely — present-but-undefined would clear it.
    assert(!("listenUnlockedAt" in patch))
})

Deno.test("stop hook: a reply owed to another chat does not keep the group unlock", () => {
    const core = owedReplyCore(COMMAND_CENTER)
    const action = stopHandle({ type: "claude_hook_stop", sessionId: "group-sess", ts: 2000 }, core)
    assertEquals(action.stateChanges.chatSessions["group-sess"].listenUnlockedAt, undefined)
})

Deno.test("stop nudge: a session is never nudged to post where listen mode refuses it", () => {
    // Still locked — e.g. the obligation was stamped when the session
    // registered, before anyone in the group had addressed the bot.
    const core = owedReplyCore()
    core.chatSessions["group-sess"].listenUnlockedAt = undefined
    const action = nudgeHandle(
        { type: "stop_nudge_fire", sessionId: "group-sess", nudgeType: "reply" },
        core,
    )
    assertEquals(effectsOfType(action, "send_text_to_claude").length, 0)
    // The obligation is dropped, so the unlock lapses on the next Stop.
    assertEquals(action.stateChanges.chatSessions["group-sess"].pendingNudgeAction, "none")
})

// ── a refused reply is shown to the operator, not discarded ────────────

function coreWithTopic() {
    const core = listeningCore()
    core.chatState.commandCenter = { chatId: COMMAND_CENTER, topicMap: { "group-sess": "77" } }
    return core
}

Deno.test("reply: a blocked reply is forwarded to the session's own topic", () => {
    const core = coreWithTopic()
    const action = channelHandle(replyEvent(GROUP), core)
    const sent = effectsOfType(action, "send_text_to_user")
    assertEquals(sent.length, 1)
    assertEquals(sent[0].replyTo.chatId, COMMAND_CENTER)
    assertEquals(sent[0].replyTo.threadId, 77)
    assert(sent[0].text.includes("hello everyone"))
    // And the agent is told its work survived, so it doesn't retry.
    const responses = effectsOfType(action, "ipc_respond")
    assert(responses[0].message.result.content[0].text.includes("NOT lost"))
    assertEquals(action.stateChanges.chatSessions["group-sess"].listenHeldForwarded, true)
})

Deno.test("reply: a retrying agent cannot flood the topic with held copies", () => {
    const core = coreWithTopic()
    core.chatSessions["group-sess"].listenHeldForwarded = true
    const action = channelHandle(replyEvent(GROUP), core)
    assertEquals(effectsOfType(action, "send_text_to_user").length, 0)
    assertEquals(effectsOfType(action, "ipc_respond").length, 1)
})

Deno.test("stop hook: the held-reply announcement is re-armed each turn", () => {
    const core = listeningCore()
    core.chatSessions["group-sess"].listenHeldForwarded = true
    const action = stopHandle({ type: "claude_hook_stop", sessionId: "group-sess", ts: 2000 }, core)
    assertEquals(action.stateChanges.chatSessions["group-sess"].listenHeldForwarded, undefined)
})

// ── the group's listen setting survives a replacement session ──────────

Deno.test("ensureGroupSession: a group told to speak respawns still speaking", () => {
    const core = makeCore({
        chatState: {
            groupChatSessions: { [GROUP]: { sessionId: "dead-sess", spawnedAt: 1, listenMode: false } },
        },
        chatSessions: {},
    })
    const ensured = ensureGroupSession(core, GROUP, "MrClank", 10_000_000)
    const spawned = ensured.stateChanges.chatSessions[ensured.sessionId]
    assertEquals(spawned.listenMode, false)
    assertEquals(ensured.stateChanges.chatState.groupChatSessions[GROUP].listenMode, false)
    // And it is told so, instead of being told it may only answer @mentions.
    const handoff = ensured.stateChanges.chatState.messageQueue[0].content
    assert(handoff.includes("Listen mode is off"))
})

Deno.test("ensureGroupSession: a new group is answered, not just listened to", () => {
    const ensured = ensureGroupSession(makeCore({ chatSessions: {} }), GROUP, "MrClank", 10_000_000)
    assertEquals(ensured.stateChanges.chatSessions[ensured.sessionId].listenMode, false)
    assertEquals(ensured.stateChanges.chatState.groupChatSessions[GROUP].listenMode, false)
})

Deno.test("ensureGroupSession: an explicit /listen on in the binding still muzzles a respawn", () => {
    const core = makeCore({ chatSessions: {} })
    core.chatState.groupChatSessions = { [GROUP]: { listenMode: true, topicName: "MrClank" } }
    const ensured = ensureGroupSession(core, GROUP, "MrClank", 10_000_000)
    assertEquals(ensured.stateChanges.chatSessions[ensured.sessionId].listenMode, true)
    assertEquals(ensured.stateChanges.chatState.groupChatSessions[GROUP].listenMode, true)
    assert(ensured.stateChanges.chatState.messageQueue[0].content.includes("addresses the bot directly"))
})

// ── a screen snapshot must not leak into the listened-to chat ──────────
//
// commands/peek.js routes the rendered screen to heldReplyTarget() when
// listensToChat() says the chat is one the session only listens to. The
// unlock must NOT open that door: scrollback is not a reply.

Deno.test("listensToChat: true for the listened-to chat, unlocked or not", () => {
    const session = { listenMode: true, listenChatId: GROUP }
    assert(listensToChat(session, GROUP))
    assert(listensToChat({ ...session, listenUnlockedAt: 999 }, GROUP))
    assertEquals(listensToChat(session, COMMAND_CENTER), false)
})

Deno.test("listensToChat: the group binding overrules a stale session flag", () => {
    // WideBird's exact shape after the v232 default flip: the session was
    // spawned muzzled, the binding says the group is answered, and no
    // inbound group message has arrived yet to refresh the flag. Without
    // the binding read the session is refused for a rule nobody holds.
    const session = { id: "WideBird", listenMode: true, listenChatId: GROUP }
    const core = { chatState: { groupChatSessions: { [GROUP]: { sessionId: "WideBird" } } } }
    assertEquals(listensToChat(session, GROUP, core), false)
    assertEquals(listenBlockReason(session, GROUP, core), null)
    // Without core the stale flag still wins — that is the window it closes.
    assert(listensToChat(session, GROUP))
})

Deno.test("listensToChat: an explicit /listen on in the binding still blocks", () => {
    const session = { id: "WideBird", listenMode: false, listenChatId: GROUP }
    const core = { chatState: { groupChatSessions: { [GROUP]: { sessionId: "WideBird", listenMode: true } } } }
    assert(listensToChat(session, GROUP, core))
    assert(listenBlockReason(session, GROUP, core))
})

Deno.test("listensToChat: another session's binding does not govern this one", () => {
    const session = { id: "OtherSession", listenMode: true, listenChatId: GROUP }
    const core = { chatState: { groupChatSessions: { [GROUP]: { sessionId: "WideBird" } } } }
    assert(listensToChat(session, GROUP, core))
})

Deno.test("listensToChat: false once listen mode is off for the group", () => {
    assertEquals(listensToChat({ listenMode: false, listenChatId: GROUP }, GROUP), false)
    assertEquals(listensToChat(undefined, GROUP), false)
})

Deno.test("heldReplyTarget: the session's own topic, never the chat it listens to", () => {
    assertEquals(heldReplyTarget(listeningCore(), "group-sess"), null)
    const target = heldReplyTarget(coreWithTopic(), "group-sess")
    assertEquals(target.chatId, COMMAND_CENTER)
    assertEquals(target.threadId, 77)
})
