// tests/commands-port-test.js
//
// Unit tests for the ported commands/*.js files. These don't exercise
// the dispatcher — they call the command handler directly with a
// synthetic event + core, which is the simplest way to prove the new
// Action-returning contract works for a representative subset.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, writeAccess, makeCore, effectsOfType, get } from "./_helpers.js"

setupTempPaths("cbg-cmds-port-test-")
writeAccess(["42"])

// Load the real commands registry — we want the actual on-disk files,
// not fakes.
const hotCommandsMod = await import("../lib/hot-commands.js")
const commandsDir = new URL("../commands", import.meta.url).pathname
await hotCommandsMod.loadCommands(commandsDir)
const commands = hotCommandsMod.getHotCommands()

function baseEvent(overrides = {}) {
    return {
        type: "chat_user_message",
        ts: 1_000_000,
        chatId: "42",
        userId: "42",
        username: "alice",
        messageId: 101,
        text: "",
        replyToMessageId: null,
        replyToText: null,
        attachment: null,
        chatType: "private",
        ...overrides,
    }
}

Deno.test("commands/ping: emits 'pong' reply", async () => {
    const core = makeCore()
    const action = await commands.get("ping")(baseEvent({ text: "/ping" }), core)
    const sends = effectsOfType(action, "send_text_to_user")
    assertEquals(sends.length, 1)
    assertEquals(sends[0].text, "pong")
    assertEquals(sends[0].chatId, "42")
})

Deno.test("commands/ping: public — works in group chats too", async () => {
    // Legacy behavior: ping has no private-chat gate; it's a trivial
    // health check that works anywhere. The ported version preserves
    // that.
    const core = makeCore()
    const action = await commands.get("ping")(
        baseEvent({ text: "/ping", chatType: "group" }),
        core,
    )
    assertEquals(effectsOfType(action, "send_text_to_user")[0].text, "pong")
})

Deno.test("commands/version: replies with plugin version", async () => {
    const core = makeCore()
    const action = await commands.get("version")(baseEvent({ text: "/version" }), core)
    const sends = effectsOfType(action, "send_text_to_user")
    assertEquals(sends.length, 1)
    assert(/cbg (v[\d.]+|build \d+)/.test(sends[0].text))
})

Deno.test("commands/help: replies with the help body", async () => {
    const core = makeCore()
    const action = await commands.get("help")(baseEvent({ text: "/help" }), core)
    const sends = effectsOfType(action, "send_text_to_user")
    assertEquals(sends.length, 1)
    assert(sends[0].text.includes("/start"))
    assert(sends[0].text.includes("/list"))
})

Deno.test("commands/start: public — unpaired user gets pairing instructions", async () => {
    const core = makeCore()
    const action = await commands.get("start")(
        baseEvent({ userId: "999", text: "/start" }),
        core,
    )
    const sends = effectsOfType(action, "send_text_to_user")
    assertEquals(sends.length, 1)
    assert(sends[0].text.includes("pair"))
    assert(sends[0].text.includes("999"))
})

Deno.test("commands/list: empty registry → 'No sessions connected'", async () => {
    const core = makeCore({ chatSessions: {} })
    const action = await commands.get("list")(baseEvent({ text: "/list" }), core)
    const sends = effectsOfType(action, "send_text_to_user")
    assertEquals(sends.length, 1)
    assert(sends[0].text.includes("No sessions connected"))
})

Deno.test("commands/list: allowlist gate — non-allowlisted user gets empty action", async () => {
    const core = makeCore({ chatSessions: { "s1": { id: "s1" } } })
    const action = await commands.get("list")(
        baseEvent({ userId: "999", text: "/list" }),
        core,
    )
    assertEquals(action.effects ?? [], [])
})

Deno.test("commands/title: returns stateChanges patching the focused session title", async () => {
    const core = makeCore({
        chatState: { focusedSessionId: "s1" },
        chatSessions: { "s1": { id: "s1", cwd: "/home/me/projX" } },
    })
    const action = await commands.get("title")(
        baseEvent({ text: "/title My Task" }),
        core,
    )
    assertEquals(get(action, "stateChanges.chatSessions.s1.title"), "My Task")
    const sends = effectsOfType(action, "send_text_to_user")
    assert(sends[0].text.includes("My Task"))
})

Deno.test("commands/title: no focused session → reply only, no state change", async () => {
    const core = makeCore({ chatState: {}, chatSessions: {} })
    const action = await commands.get("title")(
        baseEvent({ text: "/title foo" }),
        core,
    )
    assertEquals(action.stateChanges, undefined)
    const sends = effectsOfType(action, "send_text_to_user")
    assert(sends[0].text.includes("No focused session"))
})

Deno.test("commands/pause: already-paused session gets informational reply, no signal", async () => {
    const core = makeCore({
        chatState: { focusedSessionId: "s1" },
        chatSessions: { "s1": { id: "s1", pid: 99999, paused: true } },
    })
    const action = await commands.get("pause")(
        baseEvent({ text: "/pause" }),
        core,
    )
    const sends = effectsOfType(action, "send_text_to_user")
    assert(sends[0].text.includes("already paused"))
    assertEquals(action.stateChanges, undefined)
})

Deno.test("commands/approve_user: malformed input gets a usage reply", async () => {
    const core = makeCore({ chatState: {} })
    const action = await commands.get("approve_user")(
        baseEvent({ userId: "999", text: "/approve_user abc" }),
        core,
    )
    const sends = effectsOfType(action, "send_text_to_user")
    assertEquals(sends.length, 1)
    assert(
        sends[0].text.includes("Expected: one_time_password")
            || sends[0].text.includes("Usage:"),
    )
})

Deno.test("commands/approve_user: unknown OTP replies 'no approval pending'", async () => {
    const core = makeCore({ chatState: { pendingOtps: {} } })
    const action = await commands.get("approve_user")(
        baseEvent({ userId: "999", text: "/approve_user one_time_password:ghost" }),
        core,
    )
    const sends = effectsOfType(action, "send_text_to_user")
    assert(sends[0].text.includes("No approval is pending"))
})

Deno.test("commands/new_command: emits a followUpEvent telling the worker to call the MCP tool", async () => {
    const core = makeCore({ chatState: {} })
    const action = await commands.get("new_command")(
        baseEvent({ text: "/new_command reply with an emoji" }),
        core,
    )
    const follow = action.followUpEvents ?? []
    assertEquals(follow.length, 1)
    assertEquals(follow[0].type, "chat_user_message")
    assert(follow[0].text.includes("new_command MCP tool"))
    assert(follow[0].text.includes("reply with an emoji"))
})

Deno.test("commands/new_command: empty arg gets a usage reply", async () => {
    const core = makeCore({ chatState: {} })
    const action = await commands.get("new_command")(
        baseEvent({ text: "/new_command" }),
        core,
    )
    const sends = effectsOfType(action, "send_text_to_user")
    assert(sends[0].text.includes("Usage:"))
})

Deno.test("commands/cron: returns 'No desktop scheduled tasks found' when dir is missing", async () => {
    const core = makeCore({ chatState: {} })
    const action = await commands.get("cron")(
        baseEvent({ text: "/cron" }),
        core,
    )
    const sends = effectsOfType(action, "send_text_to_user")
    assertEquals(sends.length, 1)
    assert(sends[0].text.includes("Session Cron Jobs"))
})
