// tests/group-topic-memory-test.js
//
// A group chat gets a topic memory of its own: the listening session is
// spawned against a topics/<name>/ directory, is handed that memory on
// startup, and /refresh works inside the group so the memory survives a
// replacement session.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { existsSync } from "node:fs"
import { setupTempPaths, paths, makeCore } from "./_helpers.js"

const { tempDir: _tempDir } = setupTempPaths("cbg-group-topic-test-")

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

const { groupTopicName } = await import("../lib/pure/group-topic.js")
const { ensureGroupSession } = await import("../lib/listen-mode.js")

const { resolveRefreshTarget } = await import("../lib/refresh-target.js")
const { loadAccess } = await import("../lib/access.js")

// ── naming ────────────────────────────────────────────────────────────

Deno.test("groupTopicName: a plain title is the topic name", () => {
    assertEquals(groupTopicName(GROUP, "Book Club"), "Book Club")
})

Deno.test("groupTopicName: a title can never escape the topics directory", () => {
    assert(!groupTopicName(GROUP, "../../etc").includes("/"))
    assert(!groupTopicName(GROUP, "a/b").includes("/"))
    assertEquals(groupTopicName(GROUP, ".."), `group${GROUP}`)
    assertEquals(groupTopicName(GROUP, "."), `group${GROUP}`)
})

Deno.test("groupTopicName: an unusable title falls back to the chat id", () => {
    assertEquals(groupTopicName(GROUP, null), `group${GROUP}`)
    assertEquals(groupTopicName(GROUP, "   "), `group${GROUP}`)
})

Deno.test("groupTopicName: long titles are capped", () => {
    assert(groupTopicName(GROUP, "x".repeat(200)).length <= 64)
})

// ── spawning ──────────────────────────────────────────────────────────

Deno.test("a group session is spawned against its own topic memory", () => {
    const ensured = ensureGroupSession(makeCore({}), GROUP, "Book Club", 1000)
    const spawn = ensured.effects.find(e => e.type === "spawn_dtach_session")
    assertEquals(spawn.topicName, "Book Club")
    assertEquals(ensured.stateChanges.chatState.groupChatSessions[GROUP].topicName, "Book Club")
    assert(existsSync(paths.topicDir("Book Club")))
})

Deno.test("a group session is handed its memory file, and told not to answer", () => {
    const ensured = ensureGroupSession(makeCore({}), GROUP, "Book Club", 1000)
    const queued = ensured.stateChanges.chatState.messageQueue
    assertEquals(queued.length, 1)
    assertEquals(queued[0].targetSessionId, ensured.sessionId)
    assert(queued[0].content.includes(paths.topicMemoryFile("Book Club")))
    assert(queued[0].content.includes("do not answer this message"))
})

Deno.test("a group session's memory reaches its replacement", () => {
    Deno.writeTextFileSync(paths.topicMemoryFile("Book Club"), "Alice is reading Dune.")
    const core = makeCore({
        chatState: { groupChatSessions: { [GROUP]: { sessionId: "dead", spawnedAt: 0, topicName: "Book Club" } } },
        chatSessions: { "dead": { id: "dead" } },
    })
    const ensured = ensureGroupSession(core, GROUP, "Book Club", 10 * 60 * 1000)
    const prompt = ensured.stateChanges.chatState.messageQueue[0].content
    const contextFile = prompt.match(/refresh-context-\S+\.md/)
    assert(contextFile, "a handoff file should be written when there is memory to hand over")
    assert(Deno.readTextFileSync(`${paths.STATE_DIR}/${contextFile[0]}`).includes("Alice is reading Dune."))
})

Deno.test("a renamed group keeps the memory directory it already had", () => {
    const core = makeCore({
        chatState: { groupChatSessions: { [GROUP]: { sessionId: "dead", spawnedAt: 0, topicName: "Book Club" } } },
        chatSessions: { "dead": { id: "dead" } },
    })
    const ensured = ensureGroupSession(core, GROUP, "Book Club (Tuesdays)", 10 * 60 * 1000)
    const spawn = ensured.effects.find(e => e.type === "spawn_dtach_session")
    assertEquals(spawn.topicName, "Book Club")
    assertEquals(spawn.title, "Book Club (Tuesdays)")
})

// ── /refresh inside a group chat ──────────────────────────────────────
//
// Against resolveRefreshTarget rather than the command: running /refresh
// for real spawns a claude process.

function refreshEvent(chatId, overrides = {}) {
    return {
        type: "chat_user_message",
        ts: 1000,
        chatId,
        userId: "42",
        messageId: 5,
        chatType: "supergroup",
        text: "/refresh",
        _ctx: { chat: { title: "Book Club" } },
        ...overrides,
    }
}

const access = loadAccess()

Deno.test("/refresh in a group chat targets the group's own topic", () => {
    const core = makeCore({
        chatState: { groupChatSessions: { [GROUP]: { sessionId: "old", spawnedAt: 0, topicName: "Book Club" } } },
        chatSessions: { "old": { id: "old", _conn: {} } },
    })
    const target = resolveRefreshTarget(refreshEvent(GROUP), core, access)
    assertEquals(target.kind, "groupChat")
    assertEquals(target.title, "Book Club")
    assertEquals(target.existingSessionId, "old")
    assertEquals(target.threadKey, null)
})

Deno.test("/refresh in a group with no session yet still resolves a topic", () => {
    const target = resolveRefreshTarget(refreshEvent(GROUP), makeCore({}), access)
    assertEquals(target.kind, "groupChat")
    assertEquals(target.title, "Book Club")
    assertEquals(target.existingSessionId, null)
})

Deno.test("/refresh in a renamed group keeps the existing memory directory", () => {
    const core = makeCore({
        chatState: { groupChatSessions: { [GROUP]: { sessionId: "old", spawnedAt: 0, topicName: "Book Club" } } },
    })
    const event = refreshEvent(GROUP, { _ctx: { chat: { title: "Book Club (Tuesdays)" } } })
    const target = resolveRefreshTarget(event, core, access)
    assertEquals(target.title, "Book Club")
    assertEquals(target.sessionTitle, "Book Club (Tuesdays)")
})

Deno.test("/refresh in a DM is still refused", () => {
    const event = refreshEvent("42", { chatType: "private" })
    assert(resolveRefreshTarget(event, makeCore({}), access).error)
})

Deno.test("/refresh in a command center topic is unchanged", () => {
    const core = makeCore({
        chatState: {
            commandCenter: {
                threadMap: { "7": "cc-sess" },
                topicNames: { "7": "dimos" },
            },
        },
        chatSessions: { "cc-sess": { id: "cc-sess", title: "dimos" } },
    })
    const event = refreshEvent(COMMAND_CENTER, { threadId: 7 })
    const target = resolveRefreshTarget(event, core, access)
    assertEquals(target.kind, "commandCenter")
    assertEquals(target.title, "dimos")
    assertEquals(target.sessionTitle, "dimos")
    assertEquals(target.existingSessionId, "cc-sess")
})

Deno.test("/refresh in the command center, outside a topic, is refused", () => {
    const target = resolveRefreshTarget(refreshEvent(COMMAND_CENTER), makeCore({}), access)
    assert(target.error.includes("inside a topic"))
})

// ── commands that act on the chat's own session ───────────────────────
//
// /peek, /cancel and /auto_background used to return silently in any
// group chat (the guard was "private or command center"), and /cancel
// fell back to the focused session — someone else's work.

const { commandScope } = await import("../lib/command-scope.js")

Deno.test("commandScope: a group chat names its own session", () => {
    const core = makeCore({
        chatState: { groupChatSessions: { [GROUP]: { sessionId: "group-sess", spawnedAt: 0 } } },
    })
    const scope = commandScope(refreshEvent(GROUP), core, access)
    assertEquals(scope.allowed, true)
    assertEquals(scope.isGroupChat, true)
    assertEquals(scope.sessionId, "group-sess")
})

Deno.test("commandScope: a command center topic names the topic's session", () => {
    const core = makeCore({
        chatState: { commandCenter: { threadMap: { "7": "cc-sess" } } },
    })
    const event = refreshEvent(COMMAND_CENTER, { threadId: 7 })
    const scope = commandScope(event, core, access)
    assertEquals(scope.isCommandCenter, true)
    assertEquals(scope.sessionId, "cc-sess")
})

Deno.test("commandScope: a group chat with no session of its own resolves to none", () => {
    // Never the focused session: that would be someone else's work.
    assertEquals(commandScope(refreshEvent(GROUP), makeCore({}), access).sessionId, null)
})

Deno.test("commandScope: a sender who is not allowlisted gets nothing in a group", () => {
    const event = refreshEvent(GROUP, { userId: "999" })
    assertEquals(commandScope(event, makeCore({}), access).allowed, false)
})

Deno.test("commandScope: the command center needs no allowlisted sender", () => {
    const event = refreshEvent(COMMAND_CENTER, { userId: "999", threadId: 7 })
    assertEquals(commandScope(event, makeCore({}), access).allowed, true)
})

Deno.test("commandScope: a DM still requires the allowlist", () => {
    const allowed = refreshEvent("42", { chatType: "private" })
    assertEquals(commandScope(allowed, makeCore({}), access).allowed, true)
    const stranger = refreshEvent("999", { chatType: "private", userId: "999" })
    assertEquals(commandScope(stranger, makeCore({}), access).allowed, false)
})
