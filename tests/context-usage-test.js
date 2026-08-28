// tests/context-usage-test.js
//
// Unit tests for lib/pure/context-usage.js — the transcript parser behind
// /tokens. The cases that matter are the ones the TUI-scraping approach
// got wrong: reading a chunk that starts mid-line, skipping entries with
// no usage block, and counting cache reads as occupied context.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { versionedImport } from "../lib/version.js"

const {
    parseTranscriptUsage,
    contextTokensFromUsage,
    contextLimitForModel,
    summarizeContext,
    formatTokens,
    formatContextLine,
} = await versionedImport("../lib/pure/context-usage.js", import.meta)

function assistantLine({ input = 0, cacheRead = 0, cacheCreation = 0, output = 0, model = "claude-opus-4-7", ts = "2026-08-26T00:00:00Z" }) {
    return JSON.stringify({
        type: "assistant",
        timestamp: ts,
        message: {
            model,
            usage: {
                input_tokens: input,
                cache_read_input_tokens: cacheRead,
                cache_creation_input_tokens: cacheCreation,
                output_tokens: output,
            },
        },
    })
}

Deno.test("contextTokensFromUsage counts cached prefix as occupied context", () => {
    const result = contextTokensFromUsage({
        input_tokens: 2,
        cache_creation_input_tokens: 314,
        cache_read_input_tokens: 117792,
        output_tokens: 298,
    })
    assertEquals(result.tokens, 118108)
    assertEquals(result.outputTokens, 298)
})

Deno.test("contextTokensFromUsage rejects empty or missing usage", () => {
    assertEquals(contextTokensFromUsage(null), null)
    assertEquals(contextTokensFromUsage({}), null)
    assertEquals(contextTokensFromUsage({ output_tokens: 500 }), null)
})

Deno.test("parseTranscriptUsage takes the LAST assistant entry", () => {
    const text = [
        assistantLine({ cacheRead: 1000 }),
        assistantLine({ cacheRead: 5000 }),
        assistantLine({ cacheRead: 90000, input: 8 }),
        "",
    ].join("\n")
    const parsed = parseTranscriptUsage(text, { atLineStart: true })
    assert(parsed.ok)
    assertEquals(parsed.tokens, 90008)
})

Deno.test("parseTranscriptUsage skips user entries and entries without usage", () => {
    const text = [
        assistantLine({ cacheRead: 4000 }),
        JSON.stringify({ type: "user", message: { content: "hi" } }),
        JSON.stringify({ type: "assistant", message: { model: "m" } }),
        JSON.stringify({ type: "system", subtype: "compact_boundary" }),
        "",
    ].join("\n")
    const parsed = parseTranscriptUsage(text, { atLineStart: true })
    assert(parsed.ok)
    assertEquals(parsed.tokens, 4000)
})

Deno.test("parseTranscriptUsage drops a partial first line when reading a tail", () => {
    // A tail read starts mid-record; that fragment must not be trusted even
    // if it happens to parse.
    const truncated = assistantLine({ cacheRead: 999999 }).slice(40)
    const text = [truncated, assistantLine({ cacheRead: 7000 })].join("\n")
    const parsed = parseTranscriptUsage(text)
    assert(parsed.ok)
    assertEquals(parsed.tokens, 7000)
})

Deno.test("parseTranscriptUsage survives a corrupt line mid-file", () => {
    const text = [
        assistantLine({ cacheRead: 3000 }),
        '{"type":"assistant","message":{"usage":{"input_tok',
        "",
    ].join("\n")
    const parsed = parseTranscriptUsage(text, { atLineStart: true })
    assert(parsed.ok)
    assertEquals(parsed.tokens, 3000)
})

Deno.test("parseTranscriptUsage reports failure on a transcript with nothing usable", () => {
    const parsed = parseTranscriptUsage('{"type":"user"}\n', { atLineStart: true })
    assertEquals(parsed.ok, false)
    assert(parsed.detail.includes("no assistant entry"))
})

Deno.test("contextLimitForModel recognizes the 1m window", () => {
    assertEquals(contextLimitForModel("claude-opus-4-7"), 200000)
    assertEquals(contextLimitForModel("claude-sonnet-4-6[1m]"), 1000000)
    assertEquals(contextLimitForModel(null), 200000)
})

Deno.test("summarizeContext flags a session worth clearing", () => {
    const low = summarizeContext({ tokens: 20000, model: "claude-opus-4-7" })
    assertEquals(low.percentUsed, 10)
    assertEquals(low.shouldSuggestClear, false)

    const high = summarizeContext({ tokens: 137000, model: "claude-opus-4-7" })
    assertEquals(high.percentUsed, 69)
    assertEquals(high.remaining, 63000)
    assertEquals(high.shouldSuggestClear, true)
})

Deno.test("formatTokens is readable at every magnitude", () => {
    assertEquals(formatTokens(840), "840")
    assertEquals(formatTokens(1200), "1.2k")
    assertEquals(formatTokens(2000), "2k")
    assertEquals(formatTokens(137000), "137k")
})

Deno.test("formatContextLine only nags once clearing is worth it", () => {
    const quiet = formatContextLine(summarizeContext({ tokens: 20000 }))
    assertEquals(quiet, "20k/200k tokens (10%)")

    const loud = formatContextLine(summarizeContext({ tokens: 137000 }))
    assertEquals(loud, "137k/200k tokens (69%) — new task? /clear to save 137k tokens")
})
