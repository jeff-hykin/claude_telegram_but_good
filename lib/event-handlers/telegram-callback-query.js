// ---------------------------------------------------------------------------
// telegram_callback_query handler.
//
// Fired by the telegram translator when the user taps an inline keyboard
// button. Three patterns are understood:
//
//   perm:<allow|deny>:<requestId>   the permission prompt
//   cmderr:fix:<errorId>            "ask Claude to fix this command"
//   q:<questionId>:<optionIndex>    a button question from ANY harness —
//                                   see lib/pure/user-questions.js
//   spin:<show|hide>:<messageId>    expand / collapse an old tool-call spinner
//
// Anything else is logged and ignored.
//
// On a perm tap we:
//   1. Look up chatState.pendingPermissions[requestId]
//   2. Emit an `ipc_respond` of `{ type: "permission_reply", behavior }`
//      back over the originally-stored `_conn`, unblocking the worker.
//   3. Delete the pending entry via state patch (undefined → delete key).
//   4. Send a confirmation message into the chat.
//   5. Answer the callback query so Telegram dismisses the spinner.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { escapeMarkdown } = await versionedImport("../pure/markdown.js", import.meta)
const { decodeCallbackData, buildAnswerPayload, answeredText } = await versionedImport("../pure/user-questions.js", import.meta)
const { routeAnswer } = await versionedImport("../user-question-actions.js", import.meta)

export default function handle(event, core) {
    const { data, chatId, queryId } = event

    if (typeof data !== "string" || data.length === 0) {
        dbg("TG-CBQ", "callback_query with no data")
        return { stateChanges: {}, effects: [] }
    }

    // Button question: q:<questionId>:<optionIndex>
    const question = decodeCallbackData(data)
    if (question) {
        return handleQuestionAnswer(event, core, question)
    }

    // Hot-command error fix flow: cmderr:fix:<errorId>
    const cmderrMatch = /^cmderr:fix:(.+)$/.exec(data)
    if (cmderrMatch) {
        return handleCmderrFix(event, core, cmderrMatch[1])
    }

    // Collapsed spinner: spin:<show|hide>:<messageId>
    const spinMatch = /^spin:(show|hide):(\d+)$/.exec(data)
    if (spinMatch) {
        return {
            stateChanges: {},
            effects: [{ type: "toggle_spinner_details", chatId, messageId: spinMatch[2], expand: spinMatch[1] === "show", queryId }],
        }
    }

    // Permission flow: perm:<allow|deny>:<requestId>
    if (data.startsWith("perm:")) {
        return handlePerm(event, core)
    }

    dbg("TG-CBQ", `unknown callback_query pattern: ${data}`)
    return { stateChanges: {}, effects: [] }
}

/**
 * A tap on a question button. Deletes the pending entry, edits the keyboard
 * away, routes the answer to whoever asked, and always answers the callback
 * query so Telegram drops the spinner — including on every failure path, so a
 * stale button can't leave the user staring at a hung tap.
 */
function handleQuestionAnswer(event, core, { questionId, index }) {
    const { chatId, queryId, userId, messageId } = event
    const record = core?.chatState?.pendingQuestions?.[questionId]

    // No record, or one that never got past the message-id stash (options is
    // what makes it answerable): expired, answered, or cancelled. Toast only —
    // editing here overwrote the "answered: Keep" text on a double-tap, and
    // expiry already edits the message itself.
    if (!record || !Array.isArray(record.options)) {
        dbg("TG-CBQ", `no pending question for ${questionId}`)
        const effects = []
        if (queryId) {
            effects.push({ type: "answer_callback_query", queryId, text: "already answered or expired" })
        }
        return { stateChanges: {}, effects }
    }

    const option = record.options[index]
    if (!option) {
        dbg("TG-CBQ", `question ${questionId}: option index ${index} out of range`)
        return {
            stateChanges: {},
            effects: queryId ? [{ type: "answer_callback_query", queryId, text: "unknown option" }] : [],
        }
    }

    dbg("TG-CBQ", `question ${questionId} answered: ${option.key}`)
    const payload = buildAnswerPayload(record, option, { answeredBy: userId ?? null, now: event.ts ?? Date.now() })
    const effects = routeAnswer(record, payload, core)

    const editAt = messageId ?? record.messageId
    if (editAt && chatId) {
        effects.push({
            type: "edit_telegram_message",
            chatId,
            messageId: editAt,
            text: answeredText(record, option, escapeMarkdown),
            options: { format: "markdown", reply_markup: { inline_keyboard: [] } },
        })
    }
    if (queryId) {
        effects.push({ type: "answer_callback_query", queryId, text: option.label })
    }

    return {
        stateChanges: {
            chatState: { pendingQuestions: { [questionId]: undefined } },
        },
        effects,
    }
}

function handleCmderrFix(event, core, errorId) {
    const { chatId, queryId } = event
    const entry = core?.chatState?.commandErrors?.[errorId]
    if (!entry) {
        dbg("TG-CBQ", `no commandErrors entry for ${errorId}`)
        const effects = []
        if (chatId) {
            effects.push({
                type: "send_text_to_user",
                chatId,
                text: `Error \`${escapeMarkdown(errorId)}\` not found (may have expired)`,
                options: { parse_mode: "Markdown" },
            })
        }
        if (queryId) {
            effects.push({
                type: "answer_callback_query",
                queryId,
                text: "expired",
            })
        }
        return { stateChanges: {}, effects }
    }

    const focusedId = core?.chatState?.focusedSessionId
    if (!focusedId) {
        dbg("TG-CBQ", `cmderr:fix ${errorId} but no focused session`)
        const effects = []
        if (chatId) {
            effects.push({
                type: "send_text_to_user",
                chatId,
                text: "No focused session to forward the fix request to.",
                options: { parse_mode: "Markdown" },
            })
        }
        if (queryId) {
            effects.push({
                type: "answer_callback_query",
                queryId,
                text: "no focused session",
            })
        }
        return { stateChanges: {}, effects }
    }

    const message = [
        `The command /${entry.cmdName} failed with this error. Please look at the implementation and fix it.`,
        ``,
        `Error: ${entry.error}`,
        `Stack: ${entry.stack}`,
        ``,
        `Original command text: ${entry.originalText}`,
    ].join("\n")

    dbg("TG-CBQ", `cmderr:fix forwarding ${errorId} to session ${focusedId}`)

    const effects = [
        {
            type: "deliver_channel_event",
            sessionId: focusedId,
            content: message,
            meta: {},
        },
        {
            type: "send_text_to_user",
            chatId,
            text: "Forwarded to focused session.",
            options: { parse_mode: "Markdown" },
        },
    ]
    if (queryId) {
        effects.push({
            type: "answer_callback_query",
            queryId,
            text: "Forwarded",
        })
    }

    return {
        stateChanges: {
            chatState: {
                commandErrors: {
                    [errorId]: undefined,
                },
            },
        },
        effects,
    }
}

function handlePerm(event, core) {
    const { data, chatId, queryId } = event

    const parts = data.split(":")
    if (parts.length < 3 || (parts[1] !== "allow" && parts[1] !== "deny")) {
        dbg("TG-CBQ", `malformed perm callback: ${data}`)
        return { stateChanges: {}, effects: [] }
    }
    const decision = parts[1]
    // requestId may itself contain colons — rejoin everything after the
    // decision so a UUID-with-dashes-and-colons survives the parse.
    const requestId = parts.slice(2).join(":")

    const pending = core?.chatState?.pendingPermissions?.[requestId]
    if (!pending) {
        dbg("TG-CBQ", `no pending permission for ${requestId} (chat ${chatId})`)
        const effects = []
        if (chatId) {
            effects.push({
                type: "send_text_to_user",
                chatId,
                text: "permission request not found (may have timed out)",
                options: { parse_mode: "Markdown" },
            })
        }
        if (queryId) {
            effects.push({
                type: "answer_callback_query",
                queryId,
                text: "expired",
            })
        }
        return { stateChanges: {}, effects }
    }

    const behavior = decision === "allow" ? "allow" : "deny"
    const verbText = decision === "allow" ? "✅ Allowed" : "❌ Denied"
    const toolLabel = pending.toolName ? ` \`${escapeMarkdown(pending.toolName)}\`` : ""

    dbg("TG-CBQ", `perm ${behavior} req=${requestId} tool=${pending.toolName}`)

    const effects = [
        {
            type: "ipc_respond",
            conn: pending._conn,
            message: {
                type: "permission_reply",
                request_id: requestId,
                behavior,
            },
        },
        {
            type: "send_text_to_user",
            chatId,
            text: `${verbText}${toolLabel}`,
            options: { parse_mode: "Markdown" },
        },
    ]
    if (queryId) {
        effects.push({
            type: "answer_callback_query",
            queryId,
            text: behavior === "allow" ? "Allowed" : "Denied",
        })
    }

    return {
        stateChanges: {
            chatState: {
                pendingPermissions: {
                    [requestId]: undefined,
                },
            },
        },
        effects,
    }
}

