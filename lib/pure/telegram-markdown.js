// ---------------------------------------------------------------------------
// lib/pure/telegram-markdown.js — lenient Markdown → Telegram entities.
//
// WHY THIS EXISTS
// ----------------
// For months we sent formatted messages with `parse_mode: "Markdown"` and let
// Telegram's *legacy Markdown parser* interpret them. That parser is broken in
// ways we kept hitting:
//   - many code fences in one message → it mispairs them, and content meant to
//     be inside a fence leaks out and gets parsed as emphasis (the
//     `resolve_db_path` → `resolvedbpath` bug — balanced `_..._` eaten).
//   - one stray/unbalanced marker anywhere → HTTP 400 "can't parse entities",
//     and we fall back to stripping ALL formatting.
//   - agents write slightly-off markdown (missing escapes) → same 400.
//
// THE FIX
// --------
// Don't use Telegram's parser at all. Parse the Markdown OURSELVES into the
// plain text + an explicit list of Telegram `MessageEntity` ranges
// (offset/length spans for bold/italic/code/pre/link/…) and send those with NO
// parse_mode. Telegram then does zero parsing — it just applies the ranges we
// give it. Deterministic, never 400s, never eats an underscore.
//
// This is the "best-effort sanitation" layer: agents (and our own code) can
// write loose Markdown and it renders correctly. Unmatched markers degrade to
// literal text instead of erroring. Intraword underscores stay literal.
// Existing `escapeMarkdown` call sites keep working because we honor `\`
// escapes (the backslash is consumed, the next char is literal).
//
// Pure, zero-dependency. Offsets/lengths are UTF-16 code units — which is
// exactly what JS string `.length` and slicing produce, so `out.length`
// is always a correct Telegram offset (emoji surrogate pairs count as 2,
// same as Telegram).
//
// Supported syntax (ecosystem-tuned, see the marker map below):
//     *bold*  **bold**       → bold
//     _italic_               → italic   (single underscore)
//     __underline__          → underline
//     ~~strike~~             → strikethrough
//     ||spoiler||            → spoiler
//     `inline code`          → code     (content literal)
//     ```lang\n…\n```        → pre      (content literal, optional language)
//     [text](url)            → text_link
//
// Telegram entities CAN nest (bold containing italic) and CAN overlap, so we
// emit nested ranges as plain overlapping ranges — no escaping gymnastics.
// ---------------------------------------------------------------------------

// Delimiter strings recognized for emphasis, longest-first so `**` wins over
// `*`. Each maps to a fixed Telegram entity type. Note `*`/`**` both map to
// bold: our reply-tool docs tell agents `*bold*` (legacy Telegram), and that's
// what they actually emit, so a bare `*x*` is bold here, not italic.
const DELIMITERS = [
    { str: "**", type: "bold" },
    { str: "__", type: "underline" },
    { str: "~~", type: "strikethrough" },
    { str: "||", type: "spoiler" },
    { str: "*", type: "bold" },
    { str: "_", type: "italic" },
]

function isWordChar(ch) {
    return ch !== undefined && /[A-Za-z0-9]/.test(ch)
}

function isWhitespaceOrEdge(ch) {
    return ch === undefined || /\s/.test(ch)
}

// CommonMark-ish flanking. For underscore markers we additionally forbid
// intraword open/close, so `resolve_db_path` keeps its underscores. For
// `*`/`~~`/`||` we allow intraword (rare to matter, and matches habit).
function flanking(delim, prevChar, nextChar) {
    const underscore = delim.str === "_" || delim.str === "__"
    let canOpen = !isWhitespaceOrEdge(nextChar)
    let canClose = !isWhitespaceOrEdge(prevChar)
    if (underscore) {
        if (isWordChar(prevChar)) { canOpen = false }
        if (isWordChar(nextChar)) { canClose = false }
    }
    return { canOpen, canClose }
}

// Find a closing run of EXACTLY `n` backticks starting at or after `from`.
// Returns the index of the run start, or -1. A run of length n is only a
// match if it's not part of a longer backtick run.
function findBacktickRun(src, from, n) {
    let i = from
    while (i < src.length) {
        if (src[i] === "`") {
            let j = i
            while (j < src.length && src[j] === "`") { j++ }
            const runLen = j - i
            if (runLen === n) { return i }
            i = j
        } else {
            i++
        }
    }
    return -1
}

// Split a fenced-code body into { language, body }. A leading single-token
// line (`py`, `bash`, …) is treated as the language. Surrounding newlines
// are trimmed so the block doesn't render with blank first/last lines.
function splitFenceBody(raw) {
    let body = raw
    let language = ""
    const nl = body.indexOf("\n")
    if (nl >= 0) {
        const firstLine = body.slice(0, nl)
        if (/^[A-Za-z0-9_+#.-]{1,20}$/.test(firstLine.trim()) && firstLine.trim() === firstLine) {
            language = firstLine.trim()
            body = body.slice(nl + 1)
        }
    }
    // Trim a single leading / trailing newline introduced by the fence layout.
    body = body.replace(/^\n/, "").replace(/\n$/, "")
    return { language, body }
}

// ── Tokenizer ──────────────────────────────────────────────────────────
// Produces a flat list of tokens. Code/pre/link are resolved leaves (their
// content is literal). Emphasis markers become `delim` tokens that the
// emphasis pass pairs up; unpaired ones become literal text.
function tokenize(src) {
    const tokens = []
    let text = ""
    const flushText = () => {
        if (text.length > 0) { tokens.push({ kind: "text", value: text }); text = "" }
    }

    let i = 0
    const n = src.length
    while (i < n) {
        const ch = src[i]

        // Backslash escape — next char is literal, the backslash is dropped.
        if (ch === "\\" && i + 1 < n) {
            text += src[i + 1]
            i += 2
            continue
        }

        // Code span / fenced pre block.
        if (ch === "`") {
            let j = i
            while (j < n && src[j] === "`") { j++ }
            const runLen = j - i
            const close = findBacktickRun(src, j, runLen)
            if (close === -1) {
                // No matching closer — treat the backticks as literal text.
                text += src.slice(i, j)
                i = j
                continue
            }
            const inner = src.slice(j, close)
            flushText()
            if (runLen >= 3) {
                const { language, body } = splitFenceBody(inner)
                tokens.push({ kind: "pre", value: body, language })
            } else {
                // CommonMark: strip one surrounding space if the span isn't
                // all spaces and both ends are spaces.
                let content = inner
                if (content.length > 1 && content.startsWith(" ") && content.endsWith(" ") && content.trim() !== "") {
                    content = content.slice(1, -1)
                }
                tokens.push({ kind: "code", value: content })
            }
            i = close + runLen
            continue
        }

        // Link: [text](url)
        if (ch === "[") {
            const closeBracket = src.indexOf("]", i + 1)
            if (closeBracket !== -1 && src[closeBracket + 1] === "(") {
                const closeParen = src.indexOf(")", closeBracket + 2)
                if (closeParen !== -1) {
                    const linkText = src.slice(i + 1, closeBracket)
                    const url = src.slice(closeBracket + 2, closeParen).trim()
                    flushText()
                    if (url.length > 0) {
                        tokens.push({ kind: "link", value: linkText, url })
                    } else {
                        // Empty URL — keep the visible text, drop the markup.
                        tokens.push({ kind: "text", value: linkText })
                    }
                    i = closeParen + 1
                    continue
                }
            }
            // Not a well-formed link — literal `[`.
            text += ch
            i += 1
            continue
        }

        // Emphasis delimiter.
        let matchedDelim = null
        for (const d of DELIMITERS) {
            if (src.startsWith(d.str, i)) { matchedDelim = d; break }
        }
        if (matchedDelim) {
            const prevChar = i > 0 ? src[i - 1] : undefined
            const nextChar = src[i + matchedDelim.str.length]
            const { canOpen, canClose } = flanking(matchedDelim, prevChar, nextChar)
            if (canOpen || canClose) {
                flushText()
                tokens.push({
                    kind: "delim",
                    str: matchedDelim.str,
                    type: matchedDelim.type,
                    canOpen,
                    canClose,
                    paired: false,
                })
                i += matchedDelim.str.length
                continue
            }
            // Can neither open nor close — literal.
            text += matchedDelim.str
            i += matchedDelim.str.length
            continue
        }

        text += ch
        i += 1
    }
    flushText()
    return tokens
}

// ── Emphasis pairing ─────────────────────────────────────────────────────
// Stack-based: each closer matches the nearest compatible opener; intervening
// unmatched openers are discarded (become literal). Pairs are well-nested by
// construction, so the tree build below is unambiguous.
function pairEmphasis(tokens) {
    const stack = []
    for (let j = 0; j < tokens.length; j++) {
        const t = tokens[j]
        if (t.kind !== "delim") { continue }
        if (t.canClose) {
            let matched = false
            for (let k = stack.length - 1; k >= 0; k--) {
                const o = tokens[stack[k]]
                if (o.str === t.str && o.type === t.type && o.canOpen && !o.paired) {
                    o.paired = true
                    o.role = "open"
                    o.matchIndex = j
                    t.paired = true
                    t.role = "close"
                    t.matchIndex = stack[k]
                    stack.length = k
                    matched = true
                    break
                }
            }
            if (matched) { continue }
        }
        if (t.canOpen) { stack.push(j) }
    }
    return tokens
}

// Build a tree (array of nodes; emph nodes carry children) from paired tokens.
function buildTree(tokens, start, end) {
    const nodes = []
    let j = start
    while (j < end) {
        const t = tokens[j]
        if (t.kind === "delim" && t.paired && t.role === "open" && t.matchIndex < end) {
            const close = t.matchIndex
            nodes.push({ kind: "emph", type: t.type, children: buildTree(tokens, j + 1, close) })
            j = close + 1
        } else if (t.kind === "delim") {
            // Unpaired (or stray close) delimiter → literal text.
            nodes.push({ kind: "text", value: t.str })
            j++
        } else {
            nodes.push(t)
            j++
        }
    }
    return nodes
}

function renderNodes(nodes, ctx) {
    for (const node of nodes) {
        if (node.kind === "text") {
            ctx.out += node.value
        } else if (node.kind === "code") {
            const offset = ctx.out.length
            ctx.out += node.value
            if (node.value.length > 0) {
                ctx.entities.push({ type: "code", offset, length: node.value.length })
            }
        } else if (node.kind === "pre") {
            const offset = ctx.out.length
            ctx.out += node.value
            if (node.value.length > 0) {
                const ent = { type: "pre", offset, length: node.value.length }
                if (node.language) { ent.language = node.language }
                ctx.entities.push(ent)
            }
        } else if (node.kind === "link") {
            const offset = ctx.out.length
            ctx.out += node.value
            if (node.value.length > 0) {
                ctx.entities.push({ type: "text_link", offset, length: node.value.length, url: node.url })
            }
        } else if (node.kind === "emph") {
            const offset = ctx.out.length
            renderNodes(node.children, ctx)
            const length = ctx.out.length - offset
            if (length > 0) {
                ctx.entities.push({ type: node.type, offset, length })
            }
        }
    }
}

/**
 * Render a Markdown string to Telegram's { text, entities } shape.
 * Send the result with NO parse_mode (entities are applied verbatim).
 *
 * @param {string} markdown
 * @returns {{ text: string, entities: Array<object> }}
 */
export function renderMarkdownToEntities(markdown) {
    const src = String(markdown ?? "")
    if (src.length === 0) { return { text: "", entities: [] } }
    const tokens = pairEmphasis(tokenize(src))
    const tree = buildTree(tokens, 0, tokens.length)
    const ctx = { out: "", entities: [] }
    renderNodes(tree, ctx)
    // Telegram is happiest with entities sorted by offset.
    ctx.entities.sort((a, b) => a.offset - b.offset || b.length - a.length)
    return { text: ctx.out, entities: ctx.entities }
}

// ── Chunking (entity-aware) ───────────────────────────────────────────────
// Telegram caps messages at 4096 chars. Split the PLAIN text on the same
// paragraph/line/space preference as effects/telegram-outbound.js `chunk()`,
// then slice the entity list to each chunk, clamping offsets/lengths and
// rebasing to the chunk's start.

function clampEntitiesToRange(entities, start, end) {
    const out = []
    for (const e of entities) {
        const eStart = e.offset
        const eEnd = e.offset + e.length
        const s = Math.max(eStart, start)
        const en = Math.min(eEnd, end)
        if (en > s) {
            out.push({ ...e, offset: s - start, length: en - s })
        }
    }
    return out
}

/**
 * Split rendered { text, entities } into pieces that each fit `limit` chars,
 * with entities remapped to each piece.
 *
 * @param {string} text
 * @param {Array<object>} entities
 * @param {number} limit
 * @returns {Array<{ text: string, entities: Array<object> }>}
 */
export function chunkRendered(text, entities, limit) {
    if (text.length <= limit) {
        return [{ text, entities: entities ?? [] }]
    }
    const pieces = []
    let pos = 0
    const n = text.length
    while (pos < n) {
        let end = Math.min(pos + limit, n)
        if (end < n) {
            // Prefer breaking on a paragraph, then line, then space boundary,
            // mirroring chunk()'s heuristic (cut point must be past the
            // halfway mark of this window to be worth it).
            const windowStart = pos
            const half = pos + Math.floor(limit / 2)
            const para = text.lastIndexOf("\n\n", end)
            const line = text.lastIndexOf("\n", end)
            const space = text.lastIndexOf(" ", end)
            if (para > half) { end = para }
            else if (line > half) { end = line }
            else if (space > windowStart) { end = space }
        }
        const pieceText = text.slice(pos, end)
        pieces.push({ text: pieceText, entities: clampEntitiesToRange(entities ?? [], pos, end) })
        // Advance past the cut; drop the whitespace we broke on (spaces and
        // newlines) so the next piece doesn't start with a stray separator.
        // Offsets stay aligned because clamping rebases to the new `pos`.
        let next = end
        while (next < n && (text[next] === "\n" || text[next] === " ")) { next++ }
        pos = next
    }
    return pieces.filter((p) => p.text.length > 0)
}

/**
 * Convenience: render markdown and chunk in one call.
 * @returns {Array<{ text: string, entities: Array<object> }>}
 */
export function renderAndChunk(markdown, limit) {
    const { text, entities } = renderMarkdownToEntities(markdown)
    return chunkRendered(text, entities, limit)
}
