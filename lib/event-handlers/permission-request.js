// ---------------------------------------------------------------------------
// permission_request handler.
//
// Fired by the IPC translator when a Claude session asks the user to
// approve/deny a tool call. The handler stashes the request in
// chatState.pendingPermissions keyed by requestId (preserving the IPC
// `_conn` by-reference) and emits one Telegram message per allowFrom chat
// with an inline Allow/Deny keyboard. The callback-query handler later
// resolves the pending entry by routing a permission_reply IPC back to
// the originating shim.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { escapeHtml } = await versionedImport("../pure/html.js", import.meta)
const { loadAccess } = await versionedImport("../access.js", import.meta)
const { makeReplyTo } = await versionedImport("../pure/reply-to.js", import.meta)

// Truncate the input preview so a giant tool_input doesn't blow past
// Telegram's 4096-char message cap. The full payload is in the worker logs
// for anyone who wants the gory details.
const MAX_PREVIEW_CHARS = 1500

export default function handle(event, _core) {
    const {
        sessionId,
        requestId,
        toolName,
        description,
        inputPreview,
        ts,
        _conn,
    } = event

    if (!requestId || !toolName) {
        dbg("PERM-REQ", `invalid event: requestId=${requestId} toolName=${toolName}`)
        return { stateChanges: {}, effects: [] }
    }

    dbg("PERM-REQ", `tool=${toolName} session=${sessionId} req=${requestId}`)

    // Truncate preview, then HTML-escape so user-controlled tool input is
    // safe to drop inside <pre>...</pre>.
    let previewStr = ""
    if (typeof inputPreview === "string") {
        previewStr = inputPreview
    } else if (inputPreview != null) {
        try {
            previewStr = JSON.stringify(inputPreview)
        } catch (e) {
            dbg("PERM-REQ", "could not stringify inputPreview:", e)
            previewStr = String(inputPreview)
        }
    }
    let truncated = previewStr
    if (truncated.length > MAX_PREVIEW_CHARS) {
        truncated = truncated.slice(0, MAX_PREVIEW_CHARS) + "\n…(truncated)"
    }

    const lines = []
    lines.push(`<b>Permission request</b>`)
    lines.push(`tool: <code>${escapeHtml(toolName)}</code>`)
    if (sessionId) {
        lines.push(`session: <code>${escapeHtml(sessionId)}</code>`)
    }
    if (description) {
        lines.push(`<i>${escapeHtml(description)}</i>`)
    }
    if (truncated) {
        lines.push(`<pre>${escapeHtml(truncated)}</pre>`)
    }
    const text = lines.join("\n")

    const replyMarkup = {
        inline_keyboard: [[
            { text: "✅ Allow", callback_data: `perm:allow:${requestId}` },
            { text: "❌ Deny", callback_data: `perm:deny:${requestId}` },
        ]],
    }

    // One message per approved chat. Inline keyboards are per-message,
    // so we can't broadcast a single message to multiple chats.
    let access
    try {
        access = loadAccess()
    } catch (e) {
        dbg("PERM-REQ", "loadAccess failed:", e)
        access = { allowFrom: [] }
    }
    const allowFrom = Array.isArray(access?.allowFrom) ? access.allowFrom : []
    if (allowFrom.length === 0) {
        dbg("PERM-REQ", "no allowFrom chats — request will be unanswerable")
    }

    const effects = []
    for (const chatId of allowFrom) {
        effects.push({
            type: "send_text_to_user",
            replyTo: makeReplyTo({ chatId, threadId: null, setBy: "permission-request:ask" }),
            text,
            options: {
                parse_mode: "HTML",
                reply_markup: replyMarkup,
            },
        })
    }

    return {
        stateChanges: {
            chatState: {
                pendingPermissions: {
                    [requestId]: {
                        sessionId,
                        toolName,
                        description,
                        inputPreview: previewStr,
                        createdAt: ts,
                        _conn,
                    },
                },
            },
        },
        effects,
    }
}
