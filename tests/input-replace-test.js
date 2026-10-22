// Tests for lib/input-replace.js + commands/input_replace.js — the
// whole-word find-and-replace applied to the user's text on its way in
// to a session.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, writeAccess, makeCore, effectsOfType } from "./_helpers.js"
import { versionedImport } from "../lib/version.js"

setupTempPaths("cbg-input-replace-test-")
writeAccess(["42"])

const { loadRules, saveRules, applyInputReplace } = await versionedImport("../lib/input-replace.js", import.meta)
const { commands } = await import("../commands/input_replace.js")
const handle = (await import("../lib/event-handlers/chat-user.js")).default

const idu = { find: "idu", replace: "I don't understand" }

function event(text) {
    return { text, chatId: "123", threadId: null }
}

function sentText(action) {
    return action.effects[0].text
}

Deno.test("applyInputReplace: no rules is a pass-through", () => {
    saveRules([])
    assertEquals(applyInputReplace("idu what you mean"), "idu what you mean")
})

Deno.test("applyInputReplace: idu is replaced as a whole word, any case", () => {
    saveRules([idu])
    assertEquals(applyInputReplace("idu"), "I don't understand")
    assertEquals(applyInputReplace("hmm, IDU. why?"), "hmm, I don't understand. why?")
    assertEquals(applyInputReplace("idu idu"), "I don't understand I don't understand")
})

Deno.test("applyInputReplace: idu inside another word is untouched", () => {
    saveRules([idu])
    assertEquals(applyInputReplace("fidu idus residue idiot _idu idu2"), "fidu idus residue idiot _idu idu2")
})

Deno.test("applyInputReplace: special chars are literal and $ in the replacement is not a pattern", () => {
    saveRules([{ find: "a.c", replace: "$&ok" }])
    assertEquals(applyInputReplace("a.c abc"), "$&ok abc")
})

Deno.test("applyInputReplace: non-strings pass through untouched", () => {
    saveRules([idu])
    assertEquals(applyInputReplace(null), null)
    assertEquals(applyInputReplace(7), 7)
})

Deno.test("loadRules: drops malformed entries", () => {
    saveRules([{ find: "ok", replace: "x" }, { find: "", replace: "y" }, { replace: "z" }, null])
    assertEquals(loadRules(), [{ find: "ok", replace: "x" }])
})

Deno.test("/input_replace_add stores the rule and /input_replace_remove drops it", () => {
    saveRules([])
    let action = commands.input_replace_add(event(`/input_replace_add idu "I don't understand"`))
    assertEquals(loadRules(), [idu])
    assertEquals(sentText(action).startsWith("Added"), true)

    // Same word (any case) updates in place rather than stacking.
    action = commands.input_replace_add(event("/input_replace_add IDU dunno"))
    assertEquals(loadRules(), [{ find: "IDU", replace: "dunno" }])
    assertEquals(sentText(action).startsWith("Updated"), true)

    action = commands.input_replace_remove(event("/input_replace_remove idu"))
    assertEquals(loadRules(), [])
    assertEquals(sentText(action).startsWith("Removed"), true)
})

Deno.test("/input_replace_add without a replacement shows usage", () => {
    saveRules([])
    const action = commands.input_replace_add(event("/input_replace_add idu"))
    assertEquals(sentText(action).startsWith("Usage:"), true)
    assertEquals(loadRules(), [])
})

Deno.test("/input_replace_list shows the rules", () => {
    saveRules([idu])
    const text = sentText(commands.input_replace_list(event("/input_replace_list")))
    assertEquals(text.includes("idu -> I don't understand"), true)
})

Deno.test("chat-user: the session receives the replaced text", async () => {
    saveRules([idu])
    const core = makeCore({
        chatState: { focusedSessionId: "sess-1" },
        chatSessions: { "sess-1": { id: "sess-1", _conn: {} } },
    })
    const action = await handle({
        type: "chat_user_message",
        ts: 1_000_000,
        chatId: "42",
        userId: "42",
        username: "alice",
        messageId: 101,
        text: "idu the fidu part",
        replyToMessageId: null,
        replyToText: null,
        attachment: null,
        chatType: "private",
    }, core)
    const [deliver] = effectsOfType(action, "deliver_channel_event")
    assertEquals(deliver.content, "I don't understand the fidu part")
})
