// ---------------------------------------------------------------------------
// telegram_callback_query handler.
//
// Fired by the telegram translator when the user taps an inline keyboard
// button. Today this only handles the `perm:<allow|deny>:<requestId>`
// pattern emitted by the permission_request handler. Other prefixes (e.g.
// `cmderr:fix:...` planned for Phase 8) get logged and ignored for now.
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
const { escapeHtml } = await versionedImport("../pure/html.js", import.meta)
const { makeReplyTo } = await versionedImport("../pure/reply-to.js", import.meta)

export default function handle(event, core) {
    const { data, chatId, queryId } = event

    if (typeof data !== "string" || data.length === 0) {
        dbg("TG-CBQ", "callback_query with no data")
        return { stateChanges: {}, effects: [] }
    }

    // Hot-command error fix flow: cmderr:fix:<errorId>
    const cmderrMatch = /^cmderr:fix:(.+)$/.exec(data)
    if (cmderrMatch) {
        return handleCmderrFix(event, core, cmderrMatch[1])
    }

    // Permission flow: perm:<allow|deny>:<requestId>
    if (data.startsWith("perm:")) {
        return handlePerm(event, core)
    }

    dbg("TG-CBQ", `unknown callback_query pattern: ${data}`)
    return { stateChanges: {}, effects: [] }
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
                replyTo: makeReplyTo({ chatId, threadId: null, setBy: "telegram-callback-query:cmderr-expired" }),
                text: `Error <code>${escapeHtml(errorId)}</code> not found (may have expired)`,
                options: { parse_mode: "HTML" },
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
                replyTo: makeReplyTo({ chatId, threadId: null, setBy: "telegram-callback-query:cmderr-no-session" }),
                text: "No focused session to forward the fix request to.",
                options: { parse_mode: "HTML" },
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
            replyTo: makeReplyTo({ chatId, threadId: null, setBy: "telegram-callback-query:cmderr-forwarded" }),
            text: "Forwarded to focused session.",
            options: { parse_mode: "HTML" },
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
                replyTo: makeReplyTo({ chatId, threadId: null, setBy: "telegram-callback-query:perm-expired" }),
                text: "permission request not found (may have timed out)",
                options: { parse_mode: "HTML" },
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
    const toolLabel = pending.toolName ? ` <code>${escapeHtml(pending.toolName)}</code>` : ""

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
            replyTo: makeReplyTo({ chatId, threadId: null, setBy: `telegram-callback-query:perm-${behavior}` }),
            text: `${verbText}${toolLabel}`,
            options: { parse_mode: "HTML" },
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

