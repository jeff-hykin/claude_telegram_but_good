// tests/telegram-markdown-test.js
//
// Unit tests for lib/pure/telegram-markdown.js — the Markdown → Telegram
// entities renderer that replaces parse_mode. Heavy emphasis on the
// failure modes that motivated it: intraword underscores, code/pre with
// arbitrary metacharacters, unbalanced markers, and offset correctness
// (UTF-16, emoji).

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"
import {
    renderMarkdownToEntities,
    chunkRendered,
    renderAndChunk,
} from "../lib/pure/telegram-markdown.js"

function ent(type, offset, length, extra = {}) {
    return { type, offset, length, ...extra }
}

// ── The motivating bug: balanced underscores inside identifiers ──────────

Deno.test("intraword underscores stay literal — resolve_db_path", () => {
    const { text, entities } = renderMarkdownToEntities("def resolve_db_path(x):")
    assertEquals(text, "def resolve_db_path(x):")
    assertEquals(entities, [])
})

Deno.test("intraword underscores — fastlio2_rust_replay.py", () => {
    const { text, entities } = renderMarkdownToEntities("edited fastlio2_rust_replay.py done")
    assertEquals(text, "edited fastlio2_rust_replay.py done")
    assertEquals(entities, [])
})

Deno.test("command links like /schedule_status_x stay literal", () => {
    const { text, entities } = renderMarkdownToEntities("/schedule_status_ba1456 now")
    assertEquals(text, "/schedule_status_ba1456 now")
    assertEquals(entities, [])
})

// ── Basic emphasis ───────────────────────────────────────────────────────

Deno.test("*bold* → bold", () => {
    const { text, entities } = renderMarkdownToEntities("*bold*")
    assertEquals(text, "bold")
    assertEquals(entities, [ent("bold", 0, 4)])
})

Deno.test("**bold** → bold", () => {
    const { text, entities } = renderMarkdownToEntities("**bold**")
    assertEquals(text, "bold")
    assertEquals(entities, [ent("bold", 0, 4)])
})

Deno.test("_italic_ → italic", () => {
    const { text, entities } = renderMarkdownToEntities("_italic_")
    assertEquals(text, "italic")
    assertEquals(entities, [ent("italic", 0, 6)])
})

Deno.test("__underline__ → underline", () => {
    const { text, entities } = renderMarkdownToEntities("__under__")
    assertEquals(text, "under")
    assertEquals(entities, [ent("underline", 0, 5)])
})

Deno.test("~~strike~~ and ||spoiler||", () => {
    const a = renderMarkdownToEntities("~~gone~~")
    assertEquals(a.text, "gone")
    assertEquals(a.entities, [ent("strikethrough", 0, 4)])
    const b = renderMarkdownToEntities("||hidden||")
    assertEquals(b.text, "hidden")
    assertEquals(b.entities, [ent("spoiler", 0, 6)])
})

Deno.test("emphasis embedded in surrounding text — offsets", () => {
    const { text, entities } = renderMarkdownToEntities("a *b* c _d_ e")
    assertEquals(text, "a b c d e")
    assertEquals(entities, [ent("bold", 2, 1), ent("italic", 6, 1)])
})

// ── Code & pre: content is literal, no inner parsing ─────────────────────

Deno.test("inline code keeps underscores/stars literal", () => {
    const { text, entities } = renderMarkdownToEntities("call `resolve_db_path` here")
    assertEquals(text, "call resolve_db_path here")
    assertEquals(entities, [ent("code", 5, 15)])
})

Deno.test("fenced pre block — content literal, no inner entities", () => {
    const md = "```\nx = a_b * c_d\n```"
    const { text, entities } = renderMarkdownToEntities(md)
    assertEquals(text, "x = a_b * c_d")
    assertEquals(entities, [ent("pre", 0, 13)])
})

Deno.test("fenced pre with language", () => {
    const md = "```python\nprint(1)\n```"
    const { text, entities } = renderMarkdownToEntities(md)
    assertEquals(text, "print(1)")
    assertEquals(entities, [ent("pre", 0, 8, { language: "python" })])
})

Deno.test("many fences in one message all stay literal (the spinner case)", () => {
    const md = [
        "first `inline_one`",
        "```\ncd ~/repos\nmv fastlio2_rust_livox.db other.db\n```",
        "```\nrenamed_ok\n```",
        "edited fastlio2_rust_blueprints.py",
    ].join("\n")
    const { text, entities } = renderMarkdownToEntities(md)
    // No underscore in any of these should be eaten; entities are only the
    // code/pre spans, nothing spurious.
    assertEquals(text.includes("fastlio2_rust_livox.db"), true)
    assertEquals(text.includes("renamed_ok"), true)
    assertEquals(text.includes("fastlio2_rust_blueprints.py"), true)
    assertEquals(entities.every((e) => e.type === "code" || e.type === "pre"), true)
    assertEquals(entities.length, 3)
})

// ── Links ────────────────────────────────────────────────────────────────

Deno.test("[text](url) → text_link", () => {
    const { text, entities } = renderMarkdownToEntities("see [docs](https://x.io/a)")
    assertEquals(text, "see docs")
    assertEquals(entities, [ent("text_link", 4, 4, { url: "https://x.io/a" })])
})

Deno.test("empty-url link keeps text, drops markup", () => {
    const { text, entities } = renderMarkdownToEntities("[bare]()")
    assertEquals(text, "bare")
    assertEquals(entities, [])
})

// ── Leniency: unbalanced / stray markers degrade to literal ──────────────

Deno.test("unclosed bold marker is literal", () => {
    const { text, entities } = renderMarkdownToEntities("*not bold")
    assertEquals(text, "*not bold")
    assertEquals(entities, [])
})

Deno.test("unclosed code fence runs to end as pre... or literal if no closer", () => {
    const { text, entities } = renderMarkdownToEntities("a ` dangling")
    // No closing backtick → the backtick is literal, no entity.
    assertEquals(text, "a ` dangling")
    assertEquals(entities, [])
})

Deno.test("backslash escapes force literal markers", () => {
    const { text, entities } = renderMarkdownToEntities("\\*notbold\\* and \\_x\\_")
    assertEquals(text, "*notbold* and _x_")
    assertEquals(entities, [])
})

Deno.test("escapeMarkdown-style escaped underscores render clean (no visible backslash)", () => {
    // This is what existing escapeMarkdown() sites emit: foo\_bar
    const { text, entities } = renderMarkdownToEntities("path foo\\_bar baz")
    assertEquals(text, "path foo_bar baz")
    assertEquals(entities, [])
})

// ── Nesting ────────────────────────────────────────────────────────────────

Deno.test("nested bold + italic produce overlapping ranges", () => {
    const { text, entities } = renderMarkdownToEntities("*b _i_ b*")
    assertEquals(text, "b i b")
    // bold spans whole, italic spans the inner "i"
    const bold = entities.find((e) => e.type === "bold")
    const italic = entities.find((e) => e.type === "italic")
    assertEquals(bold, ent("bold", 0, 5))
    assertEquals(italic, ent("italic", 2, 1))
})

// ── Offset correctness with emoji (UTF-16 surrogate pairs = length 2) ────

Deno.test("emoji before emphasis — UTF-16 offsets", () => {
    const { text, entities } = renderMarkdownToEntities("😀 *x*")
    assertEquals(text, "😀 x")
    // 😀 is 2 UTF-16 units, then space → offset 3
    assertEquals(entities, [ent("bold", 3, 1)])
})

// ── Chunking with entity remap ───────────────────────────────────────────

Deno.test("chunkRendered: no split when under limit", () => {
    const pieces = chunkRendered("hello", [ent("bold", 0, 5)], 100)
    assertEquals(pieces.length, 1)
    assertEquals(pieces[0].text, "hello")
    assertEquals(pieces[0].entities, [ent("bold", 0, 5)])
})

Deno.test("chunkRendered: splits and rebases entity offsets", () => {
    // Two lines; entity on each. Force a split at the newline.
    const text = "AAAA\nBBBB"
    const entities = [ent("bold", 0, 4), ent("italic", 5, 4)]
    const pieces = chunkRendered(text, entities, 5)
    assertEquals(pieces.length, 2)
    assertEquals(pieces[0].text, "AAAA")
    assertEquals(pieces[0].entities, [ent("bold", 0, 4)])
    assertEquals(pieces[1].text, "BBBB")
    // second entity rebased to start of piece 2
    assertEquals(pieces[1].entities, [ent("italic", 0, 4)])
})

Deno.test("chunkRendered: entity spanning a boundary is clamped to both pieces", () => {
    const text = "AAAAA BBBBB"  // length 11, space at index 5
    const entities = [ent("bold", 0, 11)]
    const pieces = chunkRendered(text, entities, 6)
    assertEquals(pieces.length, 2)
    assertEquals(pieces[0].text, "AAAAA")
    assertEquals(pieces[0].entities, [ent("bold", 0, 5)])
    assertEquals(pieces[1].text, "BBBBB")
    assertEquals(pieces[1].entities, [ent("bold", 0, 5)])
})

Deno.test("renderAndChunk: convenience wrapper", () => {
    const pieces = renderAndChunk("*hi*", 100)
    assertEquals(pieces.length, 1)
    assertEquals(pieces[0].text, "hi")
    assertEquals(pieces[0].entities, [ent("bold", 0, 2)])
})

// ── Empty / degenerate ───────────────────────────────────────────────────

Deno.test("empty string", () => {
    const { text, entities } = renderMarkdownToEntities("")
    assertEquals(text, "")
    assertEquals(entities, [])
})

Deno.test("plain text with no markup", () => {
    const { text, entities } = renderMarkdownToEntities("just a normal sentence.")
    assertEquals(text, "just a normal sentence.")
    assertEquals(entities, [])
})
