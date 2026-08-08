// Tests for lib/output-replace.js + commands/output_replace.js — the
// find-and-replace applied to text on its way out to Telegram.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths } from "./_helpers.js"
import { versionedImport } from "../lib/version.js"

setupTempPaths("cbg-output-replace-test-")

const { loadRules, saveRules, applyOutputReplace, parseFindReplace } = await versionedImport("../lib/output-replace.js", import.meta)
const { commands } = await import("../commands/output_replace.js")

function event(text) {
    return { text, chatId: "123", threadId: null }
}

function sentText(action) {
    return action.effects[0].text
}

Deno.test("applyOutputReplace: no rules is a pass-through", () => {
    saveRules([])
    assertEquals(applyOutputReplace("hello florp"), "hello florp")
})

Deno.test("applyOutputReplace: replaces every occurrence, case-sensitively", () => {
    saveRules([{ find: "florp", replace: "sudo" }])
    assertEquals(applyOutputReplace("florp a; florp b; Florp c"), "sudo a; sudo b; Florp c")
})

Deno.test("applyOutputReplace: rules apply in order and can delete text", () => {
    saveRules([{ find: "a", replace: "b" }, { find: "b", replace: "" }])
    assertEquals(applyOutputReplace("aXbY"), "XY")
})

Deno.test("applyOutputReplace: special regex chars are literal", () => {
    saveRules([{ find: "a.c", replace: "ok" }])
    assertEquals(applyOutputReplace("a.c abc"), "ok abc")
})

Deno.test("applyOutputReplace: non-strings pass through untouched", () => {
    saveRules([{ find: "a", replace: "b" }])
    assertEquals(applyOutputReplace(null), null)
    assertEquals(applyOutputReplace(7), 7)
})

Deno.test("loadRules: drops malformed entries", () => {
    saveRules([{ find: "ok", replace: "x" }, { find: "", replace: "y" }, { replace: "z" }, null])
    assertEquals(loadRules(), [{ find: "ok", replace: "x" }])
})

Deno.test("parseFindReplace: unquoted, quoted, and empty replacement", () => {
    assertEquals(parseFindReplace("florp sudo"), ["florp", "sudo"])
    assertEquals(parseFindReplace('"hello there" "hi"'), ["hello there", "hi"])
    assertEquals(parseFindReplace('"secret" ""'), ["secret", ""])
    assertEquals(parseFindReplace("florp two words"), ["florp", "two words"])
})

Deno.test("/output_replace_add stores the rule and /output_replace_remove drops it", () => {
    saveRules([])
    let action = commands.output_replace_add(event("/output_replace_add florp sudo"))
    assertEquals(loadRules(), [{ find: "florp", replace: "sudo" }])
    assertEquals(sentText(action).startsWith("Added"), true)

    // Same find updates in place rather than stacking.
    action = commands.output_replace_add(event("/output_replace_add florp doas"))
    assertEquals(loadRules(), [{ find: "florp", replace: "doas" }])
    assertEquals(sentText(action).startsWith("Updated"), true)

    action = commands.output_replace_remove(event("/output_replace_remove florp"))
    assertEquals(loadRules(), [])
    assertEquals(sentText(action).startsWith("Removed"), true)
})

Deno.test("/output_replace_add without a replacement shows usage", () => {
    saveRules([])
    const action = commands.output_replace_add(event("/output_replace_add florp"))
    assertEquals(sentText(action).startsWith("Usage:"), true)
    assertEquals(loadRules(), [])
})

Deno.test("/output_replace_list opts out of its own rewriting", () => {
    saveRules([{ find: "florp", replace: "sudo" }])
    const effect = commands.output_replace_list(event("/output_replace_list")).effects[0]
    assertEquals(effect.skipOutputReplace, true)
    assertEquals(effect.text.includes("florp -> sudo"), true)
})
