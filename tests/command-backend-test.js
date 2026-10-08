// tests/command-backend-test.js
//
// /backend replaces a topic's session with one on a different agent
// backend. The parts worth pinning down are the ones a reader would get
// wrong: that the topic maps follow the new session, that the old
// session is retired by the right mechanism for ITS backend, and that
// the handoff is targeted rather than "whoever gets focus next".

import { assertEquals, assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts"
// `paths` MUST come from _helpers — a bare import of lib/paths.js builds
// a second singleton that setupTempPaths never redirected, so writes
// through it land on the real ~/.local/share/cbg.
import { setupTempPaths, makeCore, effectsOfType, paths } from "./_helpers.js"

const tempPaths = setupTempPaths("cbg-backend-cmd-test-")

Deno.writeTextFileSync(paths.ACCESS_FILE, JSON.stringify({
    dmPolicy: "pairing",
    allowFrom: ["42"],
    groups: {},
    pending: {},
    commandCenterChatId: "-100777",
}, null, 2))

const hotCommandsMod = await import("../lib/hot-commands.js")
await hotCommandsMod.loadCommands(new URL("../commands", import.meta.url).pathname)
const backendCmd = hotCommandsMod.getHotCommands().get("backend")

function event(text) {
    return {
        type: "chat_user_message",
        ts: 1_000_000,
        chatId: "-100777",
        threadId: 55,
        userId: "42",
        username: "alice",
        messageId: 101,
        text,
        chatType: "supergroup",
    }
}

function coreWithTopic(backend) {
    return makeCore({
        chatState: {
            commandCenter: {
                topicMap: { OldSession: "55" },
                threadMap: { "55": "OldSession" },
                topicNames: { "55": "cbg" },
            },
        },
        chatSessions: {
            OldSession: { id: "OldSession", title: "cbg", pid: 1234, backend },
        },
    })
}

function replyText(action) {
    return effectsOfType(action, "send_text_to_user")[0]?.text ?? ""
}

Deno.test("/backend with no argument reports the topic's current backend", async () => {
    const action = await backendCmd(event("/backend"), coreWithTopic("codex"))
    assertStringIncludes(replyText(action), "*codex*")
    assertEquals(effectsOfType(action, "spawn_dtach_session").length, 0)
})

Deno.test("/backend defaults to claude for sessions that predate the backend field", async () => {
    const core = coreWithTopic(undefined)
    const action = await backendCmd(event("/backend"), core)
    assertStringIncludes(replyText(action), "*claude*")
})

Deno.test("/backend rejects an unknown name without touching the session", async () => {
    const action = await backendCmd(event("/backend gpt5"), coreWithTopic("claude"))
    assertStringIncludes(replyText(action), "Unknown backend")
    assertEquals(effectsOfType(action, "spawn_dtach_session").length, 0)
})

Deno.test("/backend refuses to respawn a topic onto the backend it already runs", async () => {
    const action = await backendCmd(event("/backend codex"), coreWithTopic("codex"))
    assertStringIncludes(replyText(action), "already")
    assertEquals(effectsOfType(action, "spawn_dtach_session").length, 0)
})

Deno.test("/backend outside a topic is refused", async () => {
    const ev = event("/backend codex")
    delete ev.threadId
    const action = await backendCmd(ev, coreWithTopic("codex"))
    assertStringIncludes(replyText(action), "inside a topic")
})

Deno.test("/backend switching rebinds the topic and hands off targeted context", async () => {
    // codex → claude, because claude's healthCheck is a PATH lookup and
    // so is deterministic wherever cbg's own tests can run.
    const core = coreWithTopic("codex")
    const action = await backendCmd(event("/backend claude"), core)

    const spawns = effectsOfType(action, "spawn_dtach_session")
    assertEquals(spawns.length, 1)
    assertEquals(spawns[0].backend, "claude")
    assertEquals(spawns[0].title, "cbg")
    assertEquals(spawns[0].topicName, "cbg")

    const newId = spawns[0].sessionId
    const cc = action.stateChanges.chatState.commandCenter
    assertEquals(cc.threadMap["55"], newId)
    assertEquals(cc.topicMap[newId], "55")
    assertEquals(cc.topicMap.OldSession, undefined)
    assertEquals(action.stateChanges.chatState.pendingFocusId, newId)

    const queued = action.stateChanges.chatState.messageQueue
    assertEquals(queued.length, 1)
    assertEquals(queued[0].targetSessionId, newId)
    assertStringIncludes(queued[0].content, paths.topicMemoryFile("cbg"))
})

Deno.test("/backend SIGTERMs a non-claude predecessor instead of typing /exit at it", async () => {
    // "/exit" is a Claude Code slash command. A codex session would read
    // it as a user message and answer it, so it never gets sent one.
    const action = await backendCmd(event("/backend claude"), coreWithTopic("codex"))
    assertEquals(effectsOfType(action, "send_text_to_claude").length, 0)
    const closes = (action.followUpEvents ?? []).filter(e => e.type === "session_force_close")
    assertEquals(closes.length, 1)
    assertEquals(closes[0].sessionId, "OldSession")
})

Deno.test("/backend asks a claude predecessor to exit, with a force-close fallback", async () => {
    const action = await backendCmd(event("/backend codex"), coreWithTopic("claude"))
    const health = await (await import("../lib/agent-backends/index.js")).getBackend("codex").healthCheck()
    if (!health.ok) {
        // No usable codex on this machine — the command must say so
        // rather than spawning a session that cannot run.
        assertStringIncludes(replyText(action), "isn't usable")
        return
    }
    const exits = effectsOfType(action, "send_text_to_claude")
    assertEquals(exits.length, 1)
    assertEquals(exits[0].text, "/exit")
    assertEquals(exits[0].sessionId, "OldSession")
    const timers = effectsOfType(action, "set_timer")
    assertEquals(timers[0].event.type, "session_force_close")
    assertEquals(action.followUpEvents.length, 0)
})

const { prepareTopicHandoff } = await (await import("../lib/version.js")).versionedImport("../lib/topic-context.js", import.meta)

Deno.test("prepareTopicHandoff writes a file naming the topic's memory", () => {
    const memoryFile = paths.topicMemoryFile("cbg")
    Deno.mkdirSync(paths.topicDir("cbg"), { recursive: true })
    Deno.writeTextFileSync(memoryFile, "STATE: mid-refactor")

    const handoff = prepareTopicHandoff({ sessionId: "NewSession", title: "cbg" })
    assert(handoff.contextFile)
    const written = Deno.readTextFileSync(handoff.contextFile)
    assertStringIncludes(written, "STATE: mid-refactor")
    assertStringIncludes(written, memoryFile)
    assertStringIncludes(handoff.prompt, handoff.contextFile)
    assertStringIncludes(handoff.note, "topic memory")
})

Deno.test("prepareTopicHandoff still points a fresh topic at its memory file", () => {
    const handoff = prepareTopicHandoff({ sessionId: "NewSession", title: "BrandNewTopic" })
    assertEquals(handoff.contextFile, null)
    assertStringIncludes(handoff.prompt, paths.topicMemoryFile("BrandNewTopic"))
    assertEquals(handoff.note, "")
    assert(tempPaths)
})

const refreshCmd = hotCommandsMod.getHotCommands().get("refresh")

for (const backend of ["claude", "codex"]) {
    Deno.test(`/refresh preserves ${backend} and targets its handoff to the replacement`, async () => {
        const action = await refreshCmd(event("/refresh"), coreWithTopic(backend))
        const spawn = effectsOfType(action, "spawn_dtach_session")[0]
        assert(spawn)
        assertEquals(spawn.backend, backend)
        assertEquals(action.stateChanges.chatState.commandCenter.threadMap["55"], spawn.sessionId)
        assertEquals(action.stateChanges.chatState.messageQueue.at(-1).targetSessionId, spawn.sessionId)
        assertEquals(effectsOfType(action, "send_text_to_claude").length, backend === "claude" ? 1 : 0)
        assertEquals(effectsOfType(action, "send_text_to_user")[0].replyTo.threadId, 55)
    })
}
