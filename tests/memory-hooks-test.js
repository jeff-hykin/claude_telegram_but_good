// tests/memory-hooks-test.js
//
// Unit tests for lib/memory-hooks.js and its three trigger points:
//   - pattern compilation (literal / regex / malformed)
//   - matching, `on` scoping, and the once-per-turn exclusion set
//   - parseHookArgs for both of the documented command syntaxes
//   - addHook / removeHook round-trips
//   - the user-side hint append through chat-user.js
//   - the agent-side reply block through claude-channel.js

import { assertEquals, assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, writeAccess, makeCore, effectsOfType, fakeConn } from "./_helpers.js"
import { versionedImport } from "../lib/version.js"

const { paths } = setupTempPaths("cbg-memory-hooks-test-")
writeAccess(["42"])

const hooksMod = await versionedImport("../lib/memory-hooks.js", import.meta)
const {
    compilePattern,
    matchHooks,
    formatHintBlock,
    replyBlockText,
    toolHintText,
    toolHookAction,
    parseHookArgs,
    addHook,
    removeHook,
    loadHooks,
    saveHooks,
} = hooksMod

const chatUser = (await import("../lib/event-handlers/chat-user.js")).default
const claudeChannel = (await import("../lib/event-handlers/claude-channel.js")).default

function reset(hooks = []) {
    saveHooks(hooks)
}

// ---------------------------------------------------------------------------
// compilePattern
// ---------------------------------------------------------------------------

Deno.test("compilePattern: a bare keyword matches case-insensitively anywhere", () => {
    const regex = compilePattern("dimos")
    assert(regex.test("get DIMOS up to date"))
    assert(regex.test("dimos3"))
    assert(!regex.test("unrelated"))
})

Deno.test("compilePattern: regex metacharacters in a keyword are literal", () => {
    const regex = compilePattern("a.c")
    assert(regex.test("a.c"))
    assert(!regex.test("abc"))
})

Deno.test("compilePattern: /slashes/ make it a real regex", () => {
    const regex = compilePattern("/Manipulation Weekly/")
    assert(regex.test("skip Manipulation Weekly today"))
    assert(!regex.test("manipulation weekly"), "no implicit i flag on an explicit regex")
    assert(compilePattern("/manipulation weekly/i").test("Manipulation Weekly"))
})

Deno.test("compilePattern: the g flag is stripped so repeated tests don't alternate", () => {
    const regex = compilePattern("/dimos/g")
    assert(regex.test("dimos"))
    assert(regex.test("dimos"), "a surviving lastIndex would make the second test fail")
})

Deno.test("compilePattern: a malformed regex returns null instead of throwing", () => {
    assertEquals(compilePattern("/(unclosed/"), null)
})

// ---------------------------------------------------------------------------
// matchHooks
// ---------------------------------------------------------------------------

Deno.test("matchHooks: matches, and an unmatched pattern stays out", () => {
    reset([
        { id: "a", pattern: "dimos", hint: "see jhist" },
        { id: "b", pattern: "blender", hint: "use standard view transform" },
    ])
    const hit = matchHooks("hey get dimos up to date", "user")
    assertEquals(hit.map((hook) => hook.id), ["a"])
})

Deno.test("matchHooks: `on` scopes a rule to one side", () => {
    reset([
        { id: "u", pattern: "dimos", hint: "user only", on: "user" },
        { id: "a", pattern: "dimos", hint: "agent only", on: "agent" },
        { id: "b", pattern: "dimos", hint: "both" },
    ])
    assertEquals(matchHooks("dimos", "user").map((hook) => hook.id), ["u", "b"])
    assertEquals(matchHooks("dimos", "agent").map((hook) => hook.id), ["a", "b"])
})

Deno.test("matchHooks: excludeIds suppresses a rule that already fired this turn", () => {
    reset([{ id: "a", pattern: "dimos", hint: "see jhist" }])
    assertEquals(matchHooks("dimos", "agent", ["a"]).length, 0)
    assertEquals(matchHooks("dimos", "agent", ["other"]).length, 1)
})

Deno.test("matchHooks: empty or non-string text matches nothing", () => {
    reset([{ id: "a", pattern: "dimos", hint: "see jhist" }])
    assertEquals(matchHooks("", "user").length, 0)
    assertEquals(matchHooks(null, "user").length, 0)
})

Deno.test("matchHooks: a broken rule doesn't stop the working ones", () => {
    reset([
        { id: "bad", pattern: "/(unclosed/", hint: "never fires" },
        { id: "good", pattern: "dimos", hint: "see jhist" },
    ])
    assertEquals(matchHooks("dimos", "user").map((hook) => hook.id), ["good"])
})

Deno.test("matchHooks: matching is capped, so a hit past the cap is not found", () => {
    reset([{ id: "a", pattern: "needle", hint: "found it" }])
    const haystack = `${"x".repeat(25000)}needle`
    assertEquals(matchHooks(haystack, "agent").length, 0)
    assertEquals(matchHooks(`needle${haystack}`, "agent").length, 1)
})

Deno.test("loadHooks: a corrupt file degrades to no hooks rather than throwing", () => {
    Deno.writeTextFileSync(`${paths.CBG_DIR}/memory-hooks.json`, "{not json")
    assertEquals(loadHooks(), [])
    Deno.writeTextFileSync(`${paths.CBG_DIR}/memory-hooks.json`, `{"pattern":"x"}`)
    assertEquals(loadHooks(), [])
    reset([{ id: "a", pattern: "ok", hint: "h" }, { id: "b", pattern: "", hint: "h" }, { id: "c" }])
    assertEquals(loadHooks().map((hook) => hook.id), ["a"])
})

// ---------------------------------------------------------------------------
// formatters
// ---------------------------------------------------------------------------

Deno.test("formatHintBlock: tags each hint with the pattern that produced it", () => {
    assertEquals(formatHintBlock([]), "")
    assertEquals(
        formatHintBlock([{ pattern: "dimos", hint: "if uncertain, see jhist" }]),
        `<memory_hint keyword="dimos">if uncertain, see jhist</memory_hint>`,
    )
})

Deno.test("replyBlockText: says the reply was dropped and how to get it through", () => {
    const text = replyBlockText([{ pattern: "/Manipulation Weekly/", hint: "jeff doesn't attend that" }])
    assertStringIncludes(text, "NOT sent")
    assertStringIncludes(text, "jeff doesn't attend that")
    assertStringIncludes(text, "call reply again")
})

Deno.test("toolHintText: reads as an interjection, not a rejection", () => {
    const text = toolHintText([{ pattern: "dimos", hint: "see jhist" }])
    assertStringIncludes(text, "[memory hook]")
    assertStringIncludes(text, "see jhist")
})

// ---------------------------------------------------------------------------
// toolHookAction
// ---------------------------------------------------------------------------

Deno.test("toolHookAction: nudges the session and records the fired id", () => {
    reset([{ id: "a", pattern: "dimos", hint: "see jhist" }])
    const action = toolHookAction({}, "sess-1", ["Bash", "cd ~/repos/dimos && git pull"])
    assertEquals(action.patch.memoryHooksFired, ["a"])
    assertEquals(action.effects.length, 1)
    assertEquals(action.effects[0].type, "send_text_to_claude")
    assertEquals(action.effects[0].sessionId, "sess-1")
    assertStringIncludes(action.effects[0].text, "see jhist")
})

Deno.test("toolHookAction: returns null when nothing trips, and respects the turn's fired set", () => {
    reset([{ id: "a", pattern: "dimos", hint: "see jhist" }])
    assertEquals(toolHookAction({}, "sess-1", ["Bash", "ls"]), null)
    assertEquals(toolHookAction({ memoryHooksFired: ["a"] }, "sess-1", ["dimos"]), null)
})

// ---------------------------------------------------------------------------
// parseHookArgs
// ---------------------------------------------------------------------------

Deno.test("parseHookArgs: keyword form", () => {
    assertEquals(
        parseHookArgs("dimos if uncertain, see jhist"),
        { pattern: "dimos", hint: "if uncertain, see jhist" },
    )
})

Deno.test("parseHookArgs: regex form, with the comma the example uses", () => {
    assertEquals(
        parseHookArgs("/Manipulation Weekly/, jeff doesn't attend that"),
        { pattern: "/Manipulation Weekly/", hint: "jeff doesn't attend that" },
    )
    assertEquals(
        parseHookArgs("/dimos|dimos3/i they are the same repo"),
        { pattern: "/dimos|dimos3/i", hint: "they are the same repo" },
    )
})

Deno.test("parseHookArgs: a pattern with no hint is rejected", () => {
    assertEquals(parseHookArgs("dimos"), null)
    assertEquals(parseHookArgs("/dimos/"), null)
    assertEquals(parseHookArgs("   "), null)
})

Deno.test("parseHookArgs: an over-long hint is truncated", () => {
    const parsed = parseHookArgs(`dimos ${"x".repeat(2000)}`)
    assertEquals(parsed.hint.length, hooksMod.MAX_HINT_CHARS)
})

// ---------------------------------------------------------------------------
// addHook / removeHook
// ---------------------------------------------------------------------------

Deno.test("addHook: creates, then updates the hint of the same pattern", () => {
    reset()
    const created = addHook({ pattern: "dimos", hint: "see jhist" })
    assertEquals(created.updated, false)
    assertEquals(created.total, 1)
    assert(created.hook.id)
    assertEquals(created.hook.on, "both")

    const updated = addHook({ pattern: "dimos", hint: "see jhist wiki/index.md" })
    assertEquals(updated.updated, true)
    assertEquals(updated.total, 1, "same pattern must not duplicate")
    assertEquals(updated.hook.id, created.hook.id, "the id survives an update")
    assertEquals(loadHooks()[0].hint, "see jhist wiki/index.md")
})

Deno.test("addHook: validates pattern, hint, and the on field", () => {
    reset()
    assert(addHook({ pattern: "", hint: "x" }).error)
    assert(addHook({ pattern: "dimos", hint: "  " }).error)
    assert(addHook({ pattern: "/(unclosed/", hint: "x" }).error)
    assertEquals(addHook({ pattern: "dimos", hint: "x", on: "bogus" }).hook.on, "both")
    assertEquals(addHook({ pattern: "blender", hint: "x", on: "user" }).hook.on, "user")
})

Deno.test("removeHook: by id or by exact pattern, and reports a miss", () => {
    reset()
    const { hook } = addHook({ pattern: "dimos", hint: "see jhist" })
    addHook({ pattern: "blender", hint: "standard view transform" })

    assertEquals(removeHook(hook.id).total, 1)
    assertEquals(removeHook("blender").total, 0)
    assert(removeHook("nothing").error)
})

// ---------------------------------------------------------------------------
// user-side trigger, through the real chat-user handler
// ---------------------------------------------------------------------------

function userEvent(text) {
    return {
        type: "chat_user_message",
        ts: 1_000_000,
        chatId: "42",
        userId: "42",
        username: "alice",
        messageId: 101,
        text,
        replyToMessageId: null,
        replyToText: null,
        attachment: null,
        chatType: "private",
    }
}

function focusedCore() {
    return makeCore({
        chatState: { focusedSessionId: "sess-1" },
        chatSessions: { "sess-1": { id: "sess-1", _conn: fakeConn("shim") } },
    })
}

Deno.test("chat-user: a matching user message gets the hint appended for the agent", async () => {
    reset([{ id: "a", pattern: "dimos", hint: "if uncertain, see jhist" }])
    const action = await chatUser(userEvent("hey get dimos up to date"), focusedCore())
    const deliver = effectsOfType(action, "deliver_channel_event")[0]
    assert(deliver, "expected the message to be delivered")
    assertStringIncludes(deliver.content, "hey get dimos up to date")
    assertStringIncludes(deliver.content, `<memory_hint keyword="dimos">if uncertain, see jhist</memory_hint>`)
    assert(
        deliver.content.trimEnd().endsWith("</memory_hint>"),
        "the hint belongs at the end of the message",
    )
    assertEquals(action.stateChanges.chatSessions["sess-1"].memoryHooksFired, ["a"])
})

Deno.test("chat-user: a non-matching message is delivered untouched", async () => {
    reset([{ id: "a", pattern: "dimos", hint: "if uncertain, see jhist" }])
    const action = await chatUser(userEvent("what time is it"), focusedCore())
    const deliver = effectsOfType(action, "deliver_channel_event")[0]
    assertEquals(deliver.content, "what time is it")
    assertEquals(action.stateChanges.chatSessions["sess-1"].memoryHooksFired, undefined)
})

Deno.test("chat-user: an agent-only rule does not fire on the user's message", async () => {
    reset([{ id: "a", pattern: "dimos", hint: "see jhist", on: "agent" }])
    const action = await chatUser(userEvent("get dimos up to date"), focusedCore())
    const deliver = effectsOfType(action, "deliver_channel_event")[0]
    assertEquals(deliver.content, "get dimos up to date")
})

Deno.test("chat-user: /memory_hook_remove_<id> removes the hook", async () => {
    reset()
    const { hook } = addHook({ pattern: "dimos", hint: "see jhist" })
    const action = await chatUser(userEvent(`/memory_hook_remove_${hook.id}`), focusedCore())
    const sends = effectsOfType(action, "send_text_to_user")
    assertStringIncludes(sends[0].text, "Removed memory hook dimos")
    assertEquals(loadHooks().length, 0)
})

// ---------------------------------------------------------------------------
// agent-side trigger, through the real claude-channel handler
// ---------------------------------------------------------------------------

function replyEvent(text) {
    return {
        type: "claude_channel_tool_request",
        sessionId: "sess-1",
        toolName: "reply",
        requestId: "req-1",
        args: { chat_id: "42", text },
        _conn: fakeConn("shim"),
    }
}

function sessionCore(session = {}) {
    return makeCore({
        chatState: { focusedSessionId: "sess-1" },
        chatSessions: { "sess-1": { id: "sess-1", chatId: "42", _conn: fakeConn("shim"), ...session } },
    })
}

Deno.test("claude-channel: a reply that trips a hook is rejected, not sent", async () => {
    reset([{ id: "a", pattern: "/Manipulation Weekly/", hint: "jeff doesn't attend that" }])
    const action = await claudeChannel(replyEvent("You have Manipulation Weekly at 3pm."), sessionCore())

    assertEquals(effectsOfType(action, "send_text_to_user").length, 0, "the reply must not reach Telegram")
    const responses = effectsOfType(action, "ipc_respond")
    assertEquals(responses.length, 1)
    assertEquals(responses[0].message.result.isError, true)
    assertStringIncludes(responses[0].message.result.content[0].text, "jeff doesn't attend that")
    assertEquals(action.stateChanges.chatSessions["sess-1"].memoryHooksFired, ["a"])
})

Deno.test("claude-channel: the same reply goes through on the second attempt", async () => {
    reset([{ id: "a", pattern: "/Manipulation Weekly/", hint: "jeff doesn't attend that" }])
    const action = await claudeChannel(
        replyEvent("You have Manipulation Weekly at 3pm."),
        sessionCore({ memoryHooksFired: ["a"] }),
    )
    const responses = effectsOfType(action, "ipc_respond")
    assert(!responses.some((effect) => effect.message.result?.isError), "a fired hook must not block twice")
})

Deno.test("claude-channel: a user-only rule never blocks a reply", async () => {
    reset([{ id: "a", pattern: "dimos", hint: "see jhist", on: "user" }])
    const action = await claudeChannel(replyEvent("dimos is up to date"), sessionCore())
    const responses = effectsOfType(action, "ipc_respond")
    assert(!responses.some((effect) => effect.message.result?.isError))
})

Deno.test("claude-channel: create_memory_hook stores a hook", async () => {
    reset()
    const action = await claudeChannel({
        type: "claude_channel_tool_request",
        sessionId: "sess-1",
        toolName: "create_memory_hook",
        requestId: "req-2",
        args: { pattern: "/Manipulation Weekly/", hint: "jeff doesn't attend that", on: "agent" },
        _conn: fakeConn("shim"),
    }, sessionCore())

    const responses = effectsOfType(action, "ipc_respond")
    assertEquals(responses.length, 1)
    assert(!responses[0].message.result.isError)
    const stored = loadHooks()
    assertEquals(stored.length, 1)
    assertEquals(stored[0].pattern, "/Manipulation Weekly/")
    assertEquals(stored[0].on, "agent")
})

Deno.test("claude-channel: create_memory_hook rejects a pattern that won't compile", async () => {
    reset()
    const action = await claudeChannel({
        type: "claude_channel_tool_request",
        sessionId: "sess-1",
        toolName: "create_memory_hook",
        requestId: "req-3",
        args: { pattern: "/(unclosed/", hint: "x" },
        _conn: fakeConn("shim"),
    }, sessionCore())

    const responses = effectsOfType(action, "ipc_respond")
    assertEquals(responses[0].message.result.isError, true)
    assertEquals(loadHooks().length, 0)
})
