// ---------------------------------------------------------------------------
// lib/user-question-actions.js — the two halves of a button question that
// more than one handler needs: building the ask, and routing the answer.
//
// Kept out of the handlers so the MCP tool, a slash command, the CLI, the
// callback handler and the expiry handler all go through ONE implementation
// of "where does this get asked" and "where does the answer go".
//
// See lib/pure/user-questions.js for the wire format and the registry shape.
// ---------------------------------------------------------------------------

import { versionedImport } from "./version.js"

const { dbg } = await versionedImport("./logging.js", import.meta)
const { escapeMarkdown } = await versionedImport("./pure/markdown.js", import.meta)
const { loadAccess } = await versionedImport("./access.js", import.meta)
const { resolveTarget: resolveTargetPrefixed, parseTargetAddress } = await versionedImport("./pure/target-resolver.js", import.meta)
const { makeReplyTo, replyToForSession, sendEffect } = await versionedImport("./pure/reply-to.js", import.meta)
const {
    newQuestionId,
    validateAsk,
    buildKeyboard,
    questionText,
    answerMessageText,
    expiryDelayMs,
} = await versionedImport("./pure/user-questions.js", import.meta)

// Every answer is also appended here, whatever else happens to it. It is the
// one place a harness that died mid-question can go looking afterwards:
//   cbg inbox latest --address user_questions
export const QUESTION_LOG_INBOX = "user_questions"

/**
 * Where the question itself gets asked.
 *
 * Precedence: an explicit chat wins; otherwise the asking session's command
 * center topic (so the question lands next to the work it's about); otherwise
 * the first allowlisted chat, which is the same fallback the permission
 * prompt uses.
 */
export function resolveAskDestination(event, core) {
    if (event.chatId) {
        return makeReplyTo({
            chatId: event.chatId,
            threadId: event.threadId ?? null,
            setBy: "ask-user-question/explicit",
        })
    }
    let fallbackChatId = null
    try {
        const access = loadAccess()
        const allowFrom = Array.isArray(access?.allowFrom) ? access.allowFrom : []
        fallbackChatId = allowFrom[0] ?? null
    } catch (e) {
        dbg("ASK-Q", "loadAccess failed:", e)
    }
    const sessionId = event.askedBy?.kind === "session" ? event.askedBy.id : null
    if (sessionId) {
        const rt = replyToForSession(sessionId, core, "ask-user-question/session-topic", fallbackChatId)
        if (rt.chatId) {
            return rt
        }
    }
    if (fallbackChatId) {
        return makeReplyTo({ chatId: fallbackChatId, setBy: "ask-user-question/allowlist" })
    }
    return { chatId: null, threadId: null, setBy: "ask-user-question/nowhere" }
}

/**
 * Turn an `ask_user_question` event into an Action: one registry entry, one
 * message with an inline keyboard, one expiry timer.
 *
 * Returns `{ error }` instead of an Action when the request is malformed, so
 * the caller can answer whoever asked in the way that suits them (an MCP
 * tool error, a chat message, an IPC reply).
 */
export function buildAskAction(event, core) {
    const checked = validateAsk({
        question: event.question,
        options: event.options,
        context: event.context ?? null,
        ttlSeconds: event.ttlSeconds ?? null,
    })
    if (checked.error) {
        return { error: checked.error }
    }

    const destination = resolveAskDestination(event, core)
    if (!destination.chatId) {
        return { error: "nowhere to ask — no chatId given and no allowlisted chat" }
    }

    const now = event.ts ?? Date.now()
    const id = event.questionId ?? newQuestionId()
    const askedBy = normalizeAsker(event.askedBy, core)
    const record = {
        id,
        question: checked.question,
        context: checked.context,
        options: checked.options,
        answerTo: event.answerTo ?? defaultAnswerTo(askedBy, destination, core),
        askedBy,
        chatId: destination.chatId,
        threadId: destination.threadId ?? null,
        createdAt: now,
        expiresAt: now + checked.ttlMs,
    }

    return {
        questionId: id,
        expiresAt: record.expiresAt,
        action: {
            stateChanges: {
                chatState: { pendingQuestions: { [id]: record } },
            },
            effects: [
                {
                    // The sent message's id is stashed back onto the record so
                    // the answer / expiry can edit the keyboard away later.
                    ...sendEffect(destination, questionText(record, escapeMarkdown), {
                        format: "markdown",
                        buttons: buildKeyboard(id, record.options),
                    }),
                    stashQuestionMessageId: id,
                },
                {
                    type: "set_timer",
                    delayMs: checked.ttlMs,
                    event: { type: "user_question_expire", questionId: id },
                },
            ],
        },
    }
}

function normalizeAsker(askedBy, core) {
    if (!askedBy || typeof askedBy !== "object" || !askedBy.kind) {
        return { kind: "unknown", id: null }
    }
    if (askedBy.kind === "session" && askedBy.id) {
        const cc = core.chatState?.commandCenter ?? {}
        const threadId = cc.topicMap?.[askedBy.id] ?? null
        const topicName = threadId ? (cc.topicNames?.[threadId] ?? null) : null
        return { kind: "session", id: askedBy.id, topicName }
    }
    return { kind: askedBy.kind, id: askedBy.id ?? null }
}

/**
 * A session that didn't name a reply target gets its answer back through its
 * TOPIC when it has one, not its session id: a /refresh hands the work to a
 * new session id, and the topic follows the work.
 *
 * A command that didn't name one gets the topic it was asked in, so a custom
 * command can ask a question with no routing configuration at all and the
 * answer reaches whoever is working in that topic.
 */
function defaultAnswerTo(askedBy, destination, core) {
    if (askedBy.kind === "session" && askedBy.topicName) {
        return `topic:${askedBy.topicName}`
    }
    if (askedBy.kind === "session" && askedBy.id) {
        return `session:${askedBy.id}`
    }
    const cc = core.chatState?.commandCenter ?? {}
    const topicName = destination?.threadId != null ? (cc.topicNames?.[destination.threadId] ?? null) : null
    return topicName ? `topic:${topicName}` : null
}

/**
 * Effects that get an answer (or an expiry notice) back to whoever asked.
 *
 * The target is resolved HERE, at answer time, so a session that refreshed
 * under a new id is still reachable through `topic:<name>`. Anything that
 * doesn't resolve to a live session degrades to an inbox write — an answer is
 * never dropped just because the asker went away, and a parked `--sync` CLI
 * conn is woken by the same write.
 */
export function routeAnswer(record, payload, core) {
    const text = answerMessageText(payload)
    const meta = {
        source: "user_question",
        questionId: payload.questionId,
        status: payload.status,
        answerKey: payload.answer?.key ?? null,
    }
    const message = {
        ts: payload.answeredAt ?? Date.now(),
        from: { type: "user_question", questionId: payload.questionId, answeredBy: payload.answeredBy ?? null },
        text,
        meta: payload,
    }

    // The durable log, always.
    const effects = [{ type: "write_inbox", address: QUESTION_LOG_INBOX, message }]

    const target = record?.answerTo
    const resolved = target ? resolveTargetPrefixed(target, core) : { error: "no answerTo" }
    if (resolved?.session) {
        dbg("ASK-Q", `${payload.questionId} → session ${resolved.session.id}`)
        effects.push({
            type: "deliver_channel_event",
            sessionId: resolved.session.id,
            content: text,
            meta,
        })
        return effects
    }

    const address = inboxAddressFor(target, resolved, record)
    dbg("ASK-Q", `${payload.questionId} → inbox ${address}${resolved?.error ? ` (${resolved.error})` : ""}`)
    effects.push({ type: "write_inbox", address, message })
    effects.push({ type: "notify_inbox_waiter", address, message })
    return effects
}

function inboxAddressFor(target, resolved, record) {
    if (resolved?.inbox) {
        return resolved.inbox
    }
    if (typeof target === "string" && target.length > 0) {
        const { mode, value } = parseTargetAddress(target)
        // A topic whose session is away still has a topic inbox, and the next
        // session bound to that topic reads it — so keep the `topic:` prefix
        // rather than writing to a bare address nothing is watching.
        if (mode === "topic" && value) {
            return `topic:${value}`
        }
        if (value) {
            return value
        }
    }
    // No usable target at all: the question's own id is a unique address, and
    // the asker was handed that id when it asked.
    return record?.id ?? QUESTION_LOG_INBOX
}

export { expiryDelayMs }
