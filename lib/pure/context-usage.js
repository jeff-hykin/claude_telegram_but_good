// ---------------------------------------------------------------------------
// lib/pure/context-usage.js — how many tokens a Claude session is carrying.
//
// The obvious source is the TUI: Claude Code prints "N% until auto-compact"
// in its status area. That is a bad source. It only appears once you are
// ALREADY nearly out of room (so it can't warn you early), it is a rounded
// percentage rather than a count, and in a dtach log it is interleaved with
// cursor-movement escapes that split the digits from the words.
//
// Claude Code's own transcript is exact. Every assistant entry carries the
// `usage` block the API returned, and the context a request occupied is
//     input_tokens + cache_creation_input_tokens + cache_read_input_tokens
// because cached prefix tokens are still prefix — they cost less, but they
// still fill the window. The most recent such entry is the current size.
//
// Everything here is pure: callers hand over transcript text, this hands
// back numbers. File I/O lives in lib/agent-backends/claude.js.
// ---------------------------------------------------------------------------

/** Fallback window when the model string isn't recognized. */
export const DEFAULT_CONTEXT_LIMIT = 200000

/**
 * Context window per model. Claude Code appends "[1m]" to the model id when
 * a session is running with the 1-million-token beta window, so that suffix
 * is checked before any family match.
 */
export function contextLimitForModel(model) {
    if (typeof model !== "string" || model.length === 0) {
        return DEFAULT_CONTEXT_LIMIT
    }
    if (model.includes("[1m]") || model.includes("-1m")) {
        return 1000000
    }
    return DEFAULT_CONTEXT_LIMIT
}

/**
 * Sum the parts of a `usage` block that occupy context. Cache reads are
 * included on purpose: a cache hit is cheaper, not smaller.
 */
export function contextTokensFromUsage(usage) {
    if (!usage || typeof usage !== "object") {
        return null
    }
    const input = Number(usage.input_tokens) || 0
    const cacheCreation = Number(usage.cache_creation_input_tokens) || 0
    const cacheRead = Number(usage.cache_read_input_tokens) || 0
    const total = input + cacheCreation + cacheRead
    if (total <= 0) {
        return null
    }
    return {
        tokens: total,
        inputTokens: input,
        cacheCreationTokens: cacheCreation,
        cacheReadTokens: cacheRead,
        outputTokens: Number(usage.output_tokens) || 0,
    }
}

/**
 * Scan a chunk of transcript JSONL for the newest assistant entry that
 * carries a usage block.
 *
 * `text` may begin mid-line — callers read the tail of a multi-megabyte
 * file rather than the whole thing — so the first line is dropped unless
 * the chunk is known to start at a line boundary.
 *
 * @param {string} text
 * @param {{atLineStart?: boolean}} [options]
 * @returns {{ok: boolean, tokens?: number, model?: string, at?: string, detail?: string} & Record<string, any>}
 */
export function parseTranscriptUsage(text, { atLineStart = false } = {}) {
    if (typeof text !== "string" || text.length === 0) {
        return { ok: false, detail: "empty transcript" }
    }
    const lines = text.split("\n")
    if (!atLineStart && lines.length > 1) {
        lines.shift()
    }
    for (let index = lines.length - 1; index >= 0; index--) {
        const line = lines[index].trim()
        if (line.length === 0 || line[0] !== "{") {
            continue
        }
        let entry
        try {
            entry = JSON.parse(line)
        } catch {
            // A truncated or interleaved line is expected at chunk edges and
            // during concurrent writes; the next line back is just as good.
            continue
        }
        if (entry?.type !== "assistant") {
            continue
        }
        const breakdown = contextTokensFromUsage(entry?.message?.usage)
        if (!breakdown) {
            continue
        }
        return {
            ok: true,
            ...breakdown,
            model: entry?.message?.model ?? null,
            at: entry?.timestamp ?? null,
        }
    }
    return { ok: false, detail: "no assistant entry with usage in transcript" }
}

/** "137k" / "1.2k" / "840" — the shape a human wants in a one-line nudge. */
export function formatTokens(count) {
    const n = Number(count) || 0
    if (n < 1000) {
        return String(n)
    }
    const thousands = n / 1000
    return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1).replace(/\.0$/, "")}k`
}

/**
 * Turn a raw token count into the numbers a caller actually decides on.
 *
 * `suggestClearAtPercent` is the point past which starting an unrelated
 * task on this session is wasteful — every turn re-sends the whole window,
 * so a stale 140k of context is 140k paid on every message until it's cleared.
 */
export function summarizeContext({ tokens, model, limit, suggestClearAtPercent = 50 }) {
    const total = Number(tokens) || 0
    const contextLimit = Number(limit) || contextLimitForModel(model)
    const percentUsed = Math.round((total / contextLimit) * 100)
    return {
        tokens: total,
        limit: contextLimit,
        percentUsed,
        remaining: Math.max(0, contextLimit - total),
        model: model ?? null,
        shouldSuggestClear: percentUsed >= suggestClearAtPercent,
    }
}

/** One line, Telegram-ready, no markdown so it can go anywhere. */
export function formatContextLine(summary) {
    const used = formatTokens(summary.tokens)
    const limit = formatTokens(summary.limit)
    const base = `${used}/${limit} tokens (${summary.percentUsed}%)`
    if (!summary.shouldSuggestClear) {
        return base
    }
    return `${base} — new task? /clear to save ${used} tokens`
}
