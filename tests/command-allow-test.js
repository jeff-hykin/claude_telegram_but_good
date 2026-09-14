// tests/command-allow-test.js
//
// /allow — editing the allowlist from Telegram. The allowlist decides
// whose words reach an agent at all, so the command is stricter than the
// rest: only someone already on it may add to it, command center or not.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, paths, makeCore, effectsOfType } from "./_helpers.js"

const { tempDir: _tempDir } = setupTempPaths("cbg-command-allow-test-")

const COMMAND_CENTER = "-100222"
const ME = "42"
const STRANGER = "999"

function writeAccess(extra = {}) {
    Deno.writeTextFileSync(
        paths.ACCESS_FILE,
        JSON.stringify({
            dmPolicy: "pairing",
            allowFrom: [ME],
            groups: {},
            botCenterGroups: [],
            groupChats: [],
            pending: {},
            commandCenterChatId: COMMAND_CENTER,
            ...extra,
        }, null, 2),
    )
}
writeAccess()

const hotCommandsMod = await import("../lib/hot-commands.js")
await hotCommandsMod.loadCommands(new URL("../commands", import.meta.url).pathname)
const allowCommand = hotCommandsMod.getHotCommands().get("allow")
const { updateAllowlist } = await import("../lib/effects/access-effect.js")
const { readAccessFile } = await import("../lib/access.js")

function allowEvent(text, overrides = {}) {
    return {
        type: "chat_user_message",
        ts: 1000,
        chatId: COMMAND_CENTER,
        threadId: 5,
        userId: ME,
        messageId: 9,
        chatType: "supergroup",
        text,
        ...overrides,
    }
}

function textOf(action) {
    return effectsOfType(action, "send_text_to_user").map(e => e.text).join("\n")
}

Deno.test("/allow: someone not on the allowlist cannot hand out access", () => {
    writeAccess()
    const action = allowCommand(allowEvent("/allow 777", { userId: STRANGER }), makeCore({}))
    assertEquals(action.effects, [])
})

Deno.test("/allow: being in the command center is not enough", () => {
    // Everywhere else, membership of the CC IS the trust boundary. Not here.
    writeAccess()
    const event = allowEvent("/allow 777", { userId: "31337", chatId: COMMAND_CENTER })
    assertEquals(allowCommand(event, makeCore({})).effects, [])
})

Deno.test("/allow: bare lists who is allowed and what is pending", () => {
    writeAccess({ pending: { a4f91c: { senderId: "777", chatId: "777", expiresAt: Date.now() + 1000 } } })
    const out = textOf(allowCommand(allowEvent("/allow"), makeCore({})))
    assert(out.includes(ME))
    assert(out.includes("a4f91c"))
    assert(out.includes("777"))
})

Deno.test("/allow <id>: adds a numeric user id", () => {
    writeAccess()
    const action = allowCommand(allowEvent("/allow 777"), makeCore({}))
    const updates = effectsOfType(action, "update_allowlist")
    assertEquals(updates.length, 1)
    assertEquals(updates[0].add, ["777"])
})

Deno.test("/allow <id>: adding someone already allowed changes nothing", () => {
    writeAccess()
    const action = allowCommand(allowEvent(`/allow ${ME}`), makeCore({}))
    assertEquals(effectsOfType(action, "update_allowlist").length, 0)
    assert(textOf(action).includes("already"))
})

Deno.test("/allow <code>: approves a pairing code and tells the sender", () => {
    writeAccess({ pending: { a4f91c: { senderId: "777", chatId: "555", expiresAt: Date.now() + 1000 } } })
    const action = allowCommand(allowEvent("/allow a4f91c"), makeCore({}))
    const update = effectsOfType(action, "update_allowlist")[0]
    assertEquals(update.add, ["777"])
    assertEquals(update.clearPending, ["a4f91c"])
    const notice = effectsOfType(action, "send_text_to_user").find(e => e.chatId === "555")
    assert(notice, "the paired sender should be told, in the chat they wrote from")
})

Deno.test("/allow <code>: an expired or unknown code is not silently accepted", () => {
    writeAccess()
    const action = allowCommand(allowEvent("/allow a4f91c"), makeCore({}))
    assertEquals(effectsOfType(action, "update_allowlist").length, 0)
    assert(textOf(action).includes("Not a user id"))
})

Deno.test("/allow: replying to someone's message adds that person", () => {
    writeAccess()
    const event = allowEvent("/allow", {
        _ctx: { message: { reply_to_message: { from: { id: 777, username: "bob", is_bot: false } } } },
    })
    const update = effectsOfType(allowCommand(event, makeCore({})), "update_allowlist")[0]
    assertEquals(update.add, ["777"])
})

Deno.test("/allow: replying to the bot's own message is refused", () => {
    writeAccess()
    const event = allowEvent("/allow", {
        _ctx: { message: { reply_to_message: { from: { id: 1, username: "MrClank", is_bot: true } } } },
    })
    const action = allowCommand(event, makeCore({}))
    assertEquals(effectsOfType(action, "update_allowlist").length, 0)
    assert(textOf(action).includes("bot's message"))
})

Deno.test("/allow @username: says why it cannot work", () => {
    writeAccess()
    const action = allowCommand(allowEvent("/allow @bob"), makeCore({}))
    assertEquals(effectsOfType(action, "update_allowlist").length, 0)
    assert(textOf(action).includes("username"))
})

Deno.test("/allow remove <id>: takes someone off", () => {
    writeAccess({ allowFrom: [ME, "777"] })
    const update = effectsOfType(allowCommand(allowEvent("/allow remove 777"), makeCore({})), "update_allowlist")[0]
    assertEquals(update.remove, ["777"])
})

Deno.test("/allow remove: you cannot lock yourself out", () => {
    writeAccess()
    const action = allowCommand(allowEvent(`/allow remove ${ME}`), makeCore({}))
    assertEquals(effectsOfType(action, "update_allowlist").length, 0)
    assert(textOf(action).includes("lock you out"))
})

// ── the effect ────────────────────────────────────────────────────────

Deno.test("update_allowlist: adds, removes, and clears a pairing code on disk", () => {
    writeAccess({ pending: { a4f91c: { senderId: "777", chatId: "555", expiresAt: Date.now() + 1000 } } })
    updateAllowlist({ add: ["777"], clearPending: ["a4f91c"] })
    let after = readAccessFile()
    assertEquals(after.allowFrom, [ME, "777"])
    assertEquals(after.pending, {})

    updateAllowlist({ remove: ["777"] })
    after = readAccessFile()
    assertEquals(after.allowFrom, [ME])
})

Deno.test("update_allowlist: adding someone twice does not duplicate them", () => {
    writeAccess()
    updateAllowlist({ add: ["777"] })
    updateAllowlist({ add: ["777"] })
    assertEquals(readAccessFile().allowFrom, [ME, "777"])
})

Deno.test("update_allowlist: an empty patch leaves the file alone", () => {
    writeAccess({ allowFrom: [ME, "777"] })
    updateAllowlist({})
    assertEquals(readAccessFile().allowFrom, [ME, "777"])
})
