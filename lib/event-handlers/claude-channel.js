// ---------------------------------------------------------------------------
// claude_channel_tool_request handler.
//
// Fired by the IPC translator whenever a Claude session's shim invokes one
// of the MCP tools (reply, react, edit_message, download_attachment,
// new_command, reload, set_title). The handler is PURE — it returns an
// Action describing the side-effect to run plus an immediate ipc_respond
// effect that hands a tool_response back to the shim.
//
// We're optimistic: the Grammy outbound effects are queued and we reply
// "ok" immediately. If the actual Grammy call later fails, the tooling
// layer logs via dbg() but no error is propagated back to the worker.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { paths } = await versionedImport("../paths.js", import.meta)

export default function handle(event, core) {
    const { toolName, args = {}, requestId, _conn, sessionId } = event

    if (!toolName || typeof toolName !== "string") {
        return replyError(_conn, requestId, "missing toolName")
    }

    dbg("CHANNEL", `tool=${toolName} session=${sessionId}`)

    switch (toolName) {
        case "reply":               return handleReply(event, core)
        case "react":               return handleReact(event, core)
        case "edit_message":        return handleEdit(event, core)
        case "download_attachment": return handleDownload(event, core)
        case "new_command":         return handleNewCommand(event, core)
        case "reload":              return handleReload(event, core)
        case "set_title":           return handleSetTitle(event, core)
        default:
            dbg("CHANNEL", `unknown tool: ${toolName}`)
            return replyError(_conn, requestId, `unknown tool: ${toolName}`)
    }
}

// ── reply ──────────────────────────────────────────────────────────────

function handleReply(event, core) {
    const { args = {}, requestId, _conn, sessionId, ts } = event
    const chatId = args.chat_id
    const text = args.text

    if (!chatId) {
        return replyError(_conn, requestId, "reply: missing chat_id")
    }
    if (typeof text !== "string") {
        return replyError(_conn, requestId, "reply: missing text")
    }

    const options = buildFormatOptions(args.format)
    if (args.reply_to) {
        options.reply_to_message_id = args.reply_to
    }

    // Reply-to routing is now driven by state lookups on
    // `specialData.telegramMessagesByChatId` — each outbound we record
    // carries the originating sessionId, and chat-user.js reads
    // that off the stored entry. No header prefix needed on the text
    // itself, so the user never sees `/chat_<id>` in their quoted-reply
    // previews. (See lib/effects/telegram-state.js for the storage.)
    const headeredText = text

    const effects = []
    // recordAs is read by the outbound tooling after Grammy returns a
    // Message; it stamps this outbound into `specialData.telegramMessagesByChatId`
    // so later reply-to routing and spinner rolling-buffer edits can
    // look up the bot's own messages by id.
    const recordAs = {
        from: "agent",
        kind: "regular",
        sessionId: sessionId ?? null,
        text: text.slice(0, 500),
        ts: ts ?? Date.now(),
    }

    if (Array.isArray(args.files) && args.files.length > 0) {
        // Send each file as its own document. Caption attached only to
        // the first file so the text isn't repeated. The first file's
        // caption ALSO carries the routing header so reply-to-file works.
        for (let i = 0; i < args.files.length; i++) {
            const filePath = args.files[i]
            if (typeof filePath !== "string" || filePath.length === 0) {
                continue
            }
            const filename = filePath.split("/").pop() || filePath
            effects.push({
                type: "send_file_to_user",
                chatId,
                filePath,
                filename,
                caption: i === 0 ? headeredText : undefined,
                recordAs,
            })
        }
    } else {
        effects.push({
            type: "send_text_to_user",
            chatId,
            text: headeredText,
            options,
            recordAs,
        })
    }

    // Cold-storage trail of agent-side messages, capped to 500 chars so
    // the jsonl doesn't grow unbounded for verbose replies.
    effects.push({
        type: "cold_append",
        stream: "messages",
        entry: {
            from: "agent",
            chatId,
            text: text.slice(0, 500),
            sessionId,
            ts,
        },
    })

    // No clear_session_spinner effect emitted — the built-in spinner
    // policy in main-event-processor.js detects reply tool calls and
    // freezes the spinner after the outbound effects have fired.

    // Optimistic ipc_respond — added last so the shim sees success even
    // before Grammy fires the message.
    effects.push(...replyOk(_conn, requestId, "queued"))

    // Record the outbound so the Stop-hook nudge watchdog can tell that
    // the worker has responded since the last inbound. If the session's
    // pending nudge was a reply reminder, clear it — the worker just
    // fulfilled the reply obligation. Long-task nudges (taskCheck) are
    // left alone: the task is still running, reply tool call or not.
    const sessionPatch = sessionId
        ? { lastOutboundAt: ts }
        : null
    if (sessionPatch) {
        const existing = core?.chatSessions?.[sessionId]
        if (existing?.pendingNudgeAction === "askAgentToSendChatMessage") {
            sessionPatch.pendingNudgeAction = "none"
        }
    }
    const stateChanges = sessionPatch
        ? { chatSessions: { [sessionId]: sessionPatch } }
        : {}

    return {
        stateChanges,
        effects,
    }
}

// ── react ──────────────────────────────────────────────────────────────

function handleReact(event, _core) {
    const { args = {}, requestId, _conn } = event
    const chatId = args.chat_id
    const messageId = args.message_id
    const emoji = args.emoji

    if (!chatId) {
        return replyError(_conn, requestId, "react: missing chat_id")
    }
    if (!messageId) {
        return replyError(_conn, requestId, "react: missing message_id")
    }
    if (typeof emoji !== "string") {
        return replyError(_conn, requestId, "react: missing emoji")
    }

    return {
        stateChanges: {},
        effects: [
            {
                type: "send_reaction",
                chatId,
                messageId,
                emoji,
            },
            ...replyOk(_conn, requestId, "queued"),
        ],
    }
}

// ── edit_message ───────────────────────────────────────────────────────

function handleEdit(event, _core) {
    const { args = {}, requestId, _conn } = event
    const chatId = args.chat_id
    const messageId = args.message_id
    const text = args.text

    if (!chatId) {
        return replyError(_conn, requestId, "edit_message: missing chat_id")
    }
    if (!messageId) {
        return replyError(_conn, requestId, "edit_message: missing message_id")
    }
    if (typeof text !== "string") {
        return replyError(_conn, requestId, "edit_message: missing text")
    }

    const options = buildFormatOptions(args.format)

    return {
        stateChanges: {},
        effects: [
            {
                type: "edit_telegram_message",
                chatId,
                messageId,
                text,
                options,
            },
            ...replyOk(_conn, requestId, "queued"),
        ],
    }
}

// ── download_attachment ────────────────────────────────────────────────

function handleDownload(event, _core) {
    const { args = {}, requestId, _conn } = event
    const fileId = args.file_id

    if (typeof fileId !== "string" || fileId.length === 0) {
        return replyError(_conn, requestId, "download_attachment: missing file_id")
    }

    // Two-phase: kick off the download, then reply to Claude from the
    // follow-up handler once the bytes are local. The followUpEvent is
    // re-enqueued by `lib/effects/telegram-download.js` with `imagePath`
    // set to the saved path (or null on failure).
    const followUpEvent = {
        type: "download_complete_for_tool",
        fileId,
        requestId,
        _conn,
    }

    return {
        stateChanges: {},
        effects: [
            {
                type: "download_telegram_file",
                fileId,
                followUpEvent,
            },
        ],
    }
}

// ── new_command ────────────────────────────────────────────────────────

function handleNewCommand(event, _core) {
    const { args = {}, requestId, _conn } = event
    const filename = args.filename
    const code = args.code

    if (typeof filename !== "string" || !filename.endsWith(".js")) {
        return replyError(_conn, requestId, "new_command: filename must end in .js")
    }
    if (typeof code !== "string" || code.length === 0) {
        return replyError(_conn, requestId, "new_command: missing code")
    }
    // Reject path traversal — only a flat filename allowed under the
    // custom commands directory.
    if (filename.includes("/") || filename.includes("..")) {
        return replyError(_conn, requestId, "new_command: filename must not contain '/' or '..'")
    }

    const targetPath = `${paths.CUSTOM_COMMANDS_DIR}/${filename}`

    return {
        stateChanges: {},
        effects: [
            {
                type: "write_file",
                path: targetPath,
                content: code,
            },
            // Reload immediately so the new command becomes available
            // without the user having to send /reload manually.
            { type: "reload_hot_commands" },
            ...replyOk(
                _conn,
                requestId,
                `command written to ${targetPath} and reloaded`,
            ),
        ],
    }
}

// ── reload ─────────────────────────────────────────────────────────────

function handleReload(event, _core) {
    const { requestId, _conn } = event
    return {
        stateChanges: {},
        effects: [
            { type: "reload_hot_commands" },
            ...replyOk(_conn, requestId, "Hot commands reloaded."),
        ],
    }
}

// ── set_title ──────────────────────────────────────────────────────────

function handleSetTitle(event, core) {
    const { args = {}, requestId, _conn, sessionId } = event
    const rawTitle = args.title

    if (!sessionId) {
        return replyError(_conn, requestId, "set_title: missing sessionId on event")
    }

    // Use the supplied title only if it's a non-empty trimmed string;
    // otherwise derive one from the session's cwd basename + git branch.
    // Lets Claude call set_title with `""` to mean "pick something
    // sensible based on context."
    let title
    if (typeof rawTitle === "string" && rawTitle.trim().length > 0) {
        title = rawTitle.trim()
    } else {
        const session = core?.chatSessions?.[sessionId]
        title = deriveTitle(session)
    }

    return {
        stateChanges: {
            chatSessions: {
                [sessionId]: { title },
            },
        },
        effects: replyOk(_conn, requestId, `title set to "${title}"`),
    }
}

function deriveTitle(session) {
    if (!session) { return "session" }
    const cwd = session.cwd ?? ""
    const base = cwd.split("/").filter(Boolean).pop() ?? "session"
    const branch = session.gitBranch ? ` (${session.gitBranch})` : ""
    return `${base}${branch}`
}

// ── helpers ────────────────────────────────────────────────────────────

/**
 * Build a Grammy sendMessage `options` object from the requested format.
 * Default is plain text (no parse_mode). HTML uses parse_mode: "HTML".
 * Markdown is intentionally ignored — Telegram's Markdown parsers are
 * unreliable, see CLAUDE.md.
 */
function buildFormatOptions(format) {
    if (format === "html") {
        return { parse_mode: "HTML" }
    }
    return {}
}

function replyError(conn, requestId, text) {
    return {
        stateChanges: {},
        effects: [
            {
                type: "ipc_respond",
                conn,
                message: {
                    type: "tool_response",
                    requestId,
                    result: {
                        content: [{ type: "text", text }],
                        isError: true,
                    },
                },
            },
        ],
    }
}

function replyOk(conn, requestId, text) {
    return [
        {
            type: "ipc_respond",
            conn,
            message: {
                type: "tool_response",
                requestId,
                result: {
                    content: [{ type: "text", text }],
                },
            },
        },
    ]
}
