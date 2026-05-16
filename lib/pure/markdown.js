// ---------------------------------------------------------------------------
// lib/pure/markdown.js — Telegram legacy-Markdown escaping.
//
// Pure, zero-dependency. Safe to import from any runtime.
//
// Telegram legacy Markdown (parse_mode: "Markdown") supports:
//     *bold*
//     _italic_
//     `inline code`
//     ```pre-formatted code block```
//     [text](url)
//
// To insert literal `*`, `_`, `` ` ``, or `[` in regular text, prefix with a
// backslash. Other characters (`.`, `-`, `!`, `(`, `)`, `+`, `=`, `#`, etc.)
// do NOT need escaping in legacy Markdown — that's why we picked it over
// MarkdownV2.
//
// Use `escapeMarkdown(s)` when interpolating user content into a markdown
// string. Inside `` `...` `` inline code spans you cannot use a literal
// backtick at all; the helper does not handle code-span content (the
// caller must avoid embedding raw backticks there).
// ---------------------------------------------------------------------------

export function escapeMarkdown(s) {
    return String(s)
        .replace(/\\/g, "\\\\")
        .replace(/\*/g, "\\*")
        .replace(/_/g, "\\_")
        .replace(/`/g, "\\`")
        .replace(/\[/g, "\\[")
}

/**
 * Escape a string intended to appear inside a `[link](URL)` URL slot.
 * Legacy Markdown doesn't have a great escape for `)` in URLs; the
 * pragmatic fix is to percent-encode it. Other URL chars pass through.
 */
export function escapeMarkdownUrl(s) {
    return String(s).replace(/\)/g, "%29")
}
