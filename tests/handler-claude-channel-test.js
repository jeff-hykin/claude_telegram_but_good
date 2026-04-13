// tests/handler-claude-channel-test.js
//
// Unit tests for lib/event-handlers/claude-channel.js — the shim-side
// tool dispatcher (reply / react / edit / set_title / reload /
// new_command / download_attachment).

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, makeCore, fakeConn, effectsOfType, get } from "./_helpers.js"

setupTempPaths("cbg-chan-test-")

const mod = await import("../lib/event-handlers/claude-channel.js")
const handle = mod.default

function makeEvent(toolName, args = {}, overrides = {}) {
    return {
        type: "claude_channel_tool_request",
        ts: 1_000,
        sessionId: "sess-1",
        requestId: "req-1",
        toolName,
        args,
        _conn: fakeConn("shim"),
        ...overrides,
    }
}

Deno.test("claude-channel: reply emits send_text_to_user with recordAs metadata", () => {
    const core = makeCore()
    const action = handle(makeEvent("reply", { chat_id: "42", text: "hi" }), core)
    const sends = effectsOfType(action, "send_text_to_user")
    assertEquals(sends.length, 1)
    assertEquals(sends[0].text, "hi")
    assertEquals(sends[0].chatId, "42")
    assertEquals(sends[0].recordAs.from, "agent")
    assertEquals(sends[0].recordAs.kind, "regular")
    assertEquals(sends[0].recordAs.sessionId, "sess-1")
})

Deno.test("claude-channel: reply without a sessionId still works (no clear_spinner)", () => {
    const core = makeCore()
    const event = makeEvent("reply", { chat_id: "42", text: "hi" }, { sessionId: null })
    const action = handle(event, core)
    assertEquals(effectsOfType(action, "clear_session_spinner").length, 0)
    assertEquals(effectsOfType(action, "send_text_to_user").length, 1)
})

Deno.test("claude-channel: reply clears the session spinner when sessionId is set", () => {
    const core = makeCore()
    const action = handle(makeEvent("reply", { chat_id: "42", text: "done" }), core)
    const clears = effectsOfType(action, "clear_session_spinner")
    assertEquals(clears.length, 1)
    assertEquals(clears[0].sessionId, "sess-1")
})

Deno.test("claude-channel: reply records lastOutboundAt on the session", () => {
    const core = makeCore()
    const action = handle(makeEvent("reply", { chat_id: "42", text: "ok" }), core)
    const patch = get(action, "stateChanges.chatSessions.sess-1")
    assertEquals(patch.lastOutboundAt, 1_000)
    assertEquals(patch.nudgedForInbound, false)
})

Deno.test("claude-channel: reply with files emits send_file_to_user per file", () => {
    const core = makeCore()
    const action = handle(makeEvent("reply", {
        chat_id: "42",
        text: "caption",
        files: ["/tmp/a.png", "/tmp/b.pdf"],
    }), core)
    const sends = effectsOfType(action, "send_file_to_user")
    assertEquals(sends.length, 2)
    // First file carries the caption (text)
    assertEquals(sends[0].caption, "caption")
    // Second file has no caption (undefined)
    assertEquals(sends[1].caption, undefined)
})

Deno.test("claude-channel: reply errors on missing chat_id", () => {
    const core = makeCore()
    const action = handle(makeEvent("reply", { text: "x" }), core)
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc.length, 1)
    assertEquals(ipc[0].message.result.isError, true)
    assert(ipc[0].message.result.content[0].text.includes("missing chat_id"))
})

Deno.test("claude-channel: react emits send_reaction", () => {
    const core = makeCore()
    const action = handle(makeEvent("react", {
        chat_id: "42",
        message_id: "777",
        emoji: "👍",
    }), core)
    const r = effectsOfType(action, "send_reaction")
    assertEquals(r.length, 1)
    assertEquals(r[0].emoji, "👍")
})

Deno.test("claude-channel: react errors on missing message_id", () => {
    const core = makeCore()
    const action = handle(makeEvent("react", { chat_id: "42", emoji: "👍" }), core)
    assert(effectsOfType(action, "ipc_respond")[0].message.result.isError)
})

Deno.test("claude-channel: edit_message emits edit_telegram_message", () => {
    const core = makeCore()
    const action = handle(makeEvent("edit_message", {
        chat_id: "42",
        message_id: "77",
        text: "updated",
    }), core)
    const edits = effectsOfType(action, "edit_telegram_message")
    assertEquals(edits.length, 1)
    assertEquals(edits[0].text, "updated")
})

Deno.test("claude-channel: set_title stores the trimmed title on the session", () => {
    const core = makeCore({
        chatSessions: { "sess-1": { id: "sess-1", cwd: "/home/me/proj" } },
    })
    const action = handle(makeEvent("set_title", { title: "  my task  " }), core)
    assertEquals(get(action, "stateChanges.chatSessions.sess-1.title"), "my task")
})

Deno.test("claude-channel: set_title derives a title from cwd + gitBranch when empty", () => {
    const core = makeCore({
        chatSessions: {
            "sess-1": { id: "sess-1", cwd: "/home/me/projX", gitBranch: "main" },
        },
    })
    const action = handle(makeEvent("set_title", { title: "" }), core)
    assertEquals(get(action, "stateChanges.chatSessions.sess-1.title"), "projX (main)")
})

Deno.test("claude-channel: reload emits reload_hot_commands", () => {
    const core = makeCore()
    const action = handle(makeEvent("reload"), core)
    assertEquals(effectsOfType(action, "reload_hot_commands").length, 1)
})

Deno.test("claude-channel: new_command writes the file and reloads", () => {
    const core = makeCore()
    const action = handle(makeEvent("new_command", {
        filename: "foo.js",
        code: "export const commands = {}",
    }), core)
    const writes = effectsOfType(action, "write_file")
    assertEquals(writes.length, 1)
    assert(writes[0].path.endsWith("/foo.js"))
    assertEquals(effectsOfType(action, "reload_hot_commands").length, 1)
})

Deno.test("claude-channel: new_command rejects filenames containing slashes", () => {
    const core = makeCore()
    const action = handle(makeEvent("new_command", {
        filename: "../evil.js",
        code: "x",
    }), core)
    assert(effectsOfType(action, "ipc_respond")[0].message.result.isError)
    assertEquals(effectsOfType(action, "write_file").length, 0)
})

Deno.test("claude-channel: new_command rejects non-.js filenames", () => {
    const core = makeCore()
    const action = handle(makeEvent("new_command", {
        filename: "readme.md",
        code: "x",
    }), core)
    assert(effectsOfType(action, "ipc_respond")[0].message.result.isError)
})

Deno.test("claude-channel: download_attachment emits download_telegram_file", () => {
    const core = makeCore()
    const action = handle(makeEvent("download_attachment", { file_id: "ABC123" }), core)
    const downloads = effectsOfType(action, "download_telegram_file")
    assertEquals(downloads.length, 1)
    assertEquals(downloads[0].fileId, "ABC123")
    // Follow-up event routes back through download_complete_for_tool
    assertEquals(downloads[0].followUpEvent.type, "download_complete_for_tool")
    assertEquals(downloads[0].followUpEvent.requestId, "req-1")
})

Deno.test("claude-channel: unknown tool name returns an error response", () => {
    const core = makeCore()
    const action = handle(makeEvent("made_up_tool"), core)
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc.length, 1)
    assertEquals(ipc[0].message.result.isError, true)
    assert(ipc[0].message.result.content[0].text.includes("unknown tool"))
})
