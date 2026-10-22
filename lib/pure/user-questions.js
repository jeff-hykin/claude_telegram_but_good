// ---------------------------------------------------------------------------
// lib/pure/user-questions.js — button questions any harness can ask the user.
//
// The send side of inline keyboards already worked; the RETURN path did not.
// telegram-callback-query.js knew exactly two callback_data prefixes
// (`perm:` and `cmderr:`) and logged everything else into the void, so a tap
// on any other button went nowhere. This module is the shared, prefix-generic
// half of the round trip: id generation, the `q:<id>:<index>` wire format,
// option normalization, the keyboard, and the text of both the question and
// the answered message.
//
// The question REGISTRY lives in `chatState.pendingQuestions`, which is
// persisted, so a pending question survives a daemon restart and its buttons
// keep working — the callback handler reads state, never in-process memory.
//
// Who can ask:
//   - a Claude session, via the `ask_user_question` MCP tool
//   - a builtin or custom slash command, by returning
//     `followUpEvents: [{ type: "ask_user_question", ... }]` (no imports
//     needed, so custom commands outside the repo can do it too)
//   - anything else, via `cbg question` on the CLI
//
// Who gets the answer: `answerTo` is one of the existing target-resolver
// addresses — `session:<id>`, `topic:<name>`, or `inbox:<addr>` — RESOLVED AT
// ANSWER TIME, not at ask time. A session that refreshed into a new id still
// gets its answer if it asked as `topic:<name>`, and an unresolvable target
// degrades to an inbox write rather than dropping the answer on the floor.
//
// Pure, no I/O, no versionedImport.
// ---------------------------------------------------------------------------

export const CALLBACK_PREFIX = "q"

// Telegram's callback_data is capped at 64 BYTES, so ids stay short and the
// payload is `q:<id>:<index>` — never the label, never the answer text.
export const MAX_CALLBACK_BYTES = 64

// Two is the floor everywhere — the CLI refuses fewer, and a single-button
// "question" is an announcement, which `reply` already does better.
export const MIN_OPTIONS = 2
export const MAX_OPTIONS = 5
export const MAX_LABEL_CHARS = 40
export const MAX_QUESTION_CHARS = 600
export const MAX_CONTEXT_CHARS = 400

// A question with no deadline is a button that hangs around forever and a
// waiter that never learns it lost. Default a day, cap at a week.
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
export const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const MIN_TTL_MS = 60 * 1000

// After a restart, expiry timers are re-armed from the persisted record. One
// already past due fires a minute after boot rather than instantly, so the
// asker's session has a chance to reconnect and hear about it.
export const EXPIRE_RESUME_GRACE_MS = 60 * 1000

export function newQuestionId() {
    const rand = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0")
    return `q_${Date.now().toString(36)}${rand}`
}

export function encodeCallbackData(questionId, index) {
    return `${CALLBACK_PREFIX}:${questionId}:${index}`
}

/**
 * Parse `q:<questionId>:<index>`. Returns null for anything else, so the
 * callback handler can fall through to the other prefixes untouched.
 */
export function decodeCallbackData(data) {
    if (typeof data !== "string") {
        return null
    }
    const match = /^q:([^:]+):(\d+)$/.exec(data)
    if (!match) {
        return null
    }
    return { questionId: match[1], index: Number(match[2]) }
}

/**
 * Accept options as plain strings (`["Keep", "Drop"]`) or as objects
 * (`[{ key: "keep", label: "✅ Keep" }]`) and normalize to the object form.
 *
 * `key` is what the asker matches on — it is stable and machine-ish, so a
 * relabeled button doesn't break the asker's branching. It defaults to a
 * slug of the label.
 */
export function normalizeOptions(raw) {
    if (!Array.isArray(raw) || raw.length < MIN_OPTIONS) {
        return { error: `options must be an array of at least ${MIN_OPTIONS} choices` }
    }
    if (raw.length > MAX_OPTIONS) {
        return { error: `too many options (${raw.length} > ${MAX_OPTIONS})` }
    }
    const options = []
    const seen = new Set()
    for (const entry of raw) {
        const label = typeof entry === "string" ? entry : entry?.label
        if (typeof label !== "string" || label.trim().length === 0) {
            return { error: "every option needs a non-empty label" }
        }
        const trimmed = label.trim()
        if (trimmed.length > MAX_LABEL_CHARS) {
            return { error: `option label over ${MAX_LABEL_CHARS} chars: "${trimmed.slice(0, 20)}…"` }
        }
        const key = typeof entry === "object" && typeof entry?.key === "string" && entry.key.trim()
            ? entry.key.trim()
            : slugKey(trimmed)
        if (seen.has(key)) {
            return { error: `duplicate option key "${key}"` }
        }
        seen.add(key)
        options.push({ key, label: trimmed })
    }
    return { options }
}

function slugKey(label) {
    const slug = label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 24)
    return slug || "opt"
}

/**
 * Validate an ask request and produce the parts a record is built from.
 * Returns `{ error }` or `{ question, context, options, ttlMs }`.
 */
export function validateAsk({ question, options, context = null, ttlSeconds = null }) {
    if (typeof question !== "string" || question.trim().length === 0) {
        return { error: "question is required" }
    }
    const trimmed = question.trim()
    if (trimmed.length > MAX_QUESTION_CHARS) {
        return { error: `question over ${MAX_QUESTION_CHARS} chars — put the detail in a file and ask about the short version` }
    }
    if (context != null && typeof context !== "string") {
        return { error: "context must be a string" }
    }
    const ctx = context == null ? null : context.trim().slice(0, MAX_CONTEXT_CHARS) || null
    const normalized = normalizeOptions(options)
    if (normalized.error) {
        return { error: normalized.error }
    }
    let ttlMs = DEFAULT_TTL_MS
    if (ttlSeconds != null) {
        const asMs = Number(ttlSeconds) * 1000
        if (!Number.isFinite(asMs) || asMs <= 0) {
            return { error: "timeout_seconds must be a positive number" }
        }
        ttlMs = Math.min(Math.max(asMs, MIN_TTL_MS), MAX_TTL_MS)
    }
    return { question: trimmed, context: ctx, options: normalized.options, ttlMs }
}

/**
 * Inline keyboard for a question: two buttons per row, so 40-char labels
 * still read on a phone.
 */
export function buildKeyboard(questionId, options) {
    const rows = []
    for (let i = 0; i < options.length; i += 2) {
        rows.push(
            options.slice(i, i + 2).map((opt, offset) => ({
                label: opt.label,
                callbackData: encodeCallbackData(questionId, i + offset),
            })),
        )
    }
    return rows
}

/**
 * The message body. `escape` is passed in (escapeMarkdown) rather than
 * imported so this module stays dependency-free.
 */
export function questionText(record, escape = (s) => s) {
    const lines = [`*${escape(record.question)}*`]
    if (record.context) {
        lines.push(`_${escape(record.context)}_`)
    }
    const who = askerLabel(record)
    if (who) {
        lines.push(`\`${escape(who)}\` is waiting on this`)
    }
    return lines.join("\n")
}

/** What the question message becomes once a button is tapped. */
export function answeredText(record, option, escape = (s) => s) {
    return [
        `*${escape(record.question)}*`,
        `→ ${escape(option.label)}`,
    ].join("\n")
}

/** What it becomes when nobody tapped anything in time. */
export function expiredText(record, escape = (s) => s) {
    return [
        `*${escape(record.question)}*`,
        `→ _no answer (expired)_`,
    ].join("\n")
}

export function askerLabel(record) {
    const asker = record?.askedBy
    if (!asker || typeof asker !== "object") {
        return null
    }
    if (asker.kind === "session") {
        return asker.topicName ? `topic:${asker.topicName}` : `session:${asker.id}`
    }
    if (asker.kind === "command") {
        return `/${asker.id}`
    }
    if (asker.kind === "cli") {
        return asker.id ? `cli:${asker.id}` : "cli"
    }
    return null
}

/**
 * The payload handed back to whoever asked. Small on purpose: the IPC bridge
 * truncates around 8 KB, and this rides it on the way to a session's shim.
 */
export function buildAnswerPayload(record, option, { answeredBy = null, now = Date.now() } = {}) {
    return {
        questionId: record.id,
        question: record.question,
        answer: option === null ? null : { key: option.key, label: option.label },
        status: option === null ? "expired" : "answered",
        answeredBy,
        answeredAt: now,
    }
}

/** Human-readable form of the payload, for a channel event or an inbox line. */
export function answerMessageText(payload) {
    if (payload.status === "expired") {
        return `[question ${payload.questionId} expired with no answer — "${payload.question}"]`
    }
    return `[answer to question ${payload.questionId}: ${payload.answer.label} (key: ${payload.answer.key})]\nquestion was: "${payload.question}"`
}

export function isExpired(record, now = Date.now()) {
    const at = Number(record?.expiresAt)
    return Number.isFinite(at) ? now >= at : false
}

/** How long after a restart to re-arm a question's expiry timer. */
export function expiryDelayMs(record, now = Date.now()) {
    const at = Number(record?.expiresAt)
    if (!Number.isFinite(at)) {
        return DEFAULT_TTL_MS
    }
    return at > now ? at - now : EXPIRE_RESUME_GRACE_MS
}
