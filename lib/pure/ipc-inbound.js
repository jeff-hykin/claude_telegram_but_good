// ---------------------------------------------------------------------------
// lib/pure/ipc-inbound.js — server-side inbound IPC dispatcher.
//
// The ONLY caller is main-server.js's per-connection read loop. That
// loop calls `parseIpcMessages` from lib/ipc.js to do framing + JSON
// decoding, then hands each parsed message to `translateIpcMessage`
// (below), which dispatches on `msg.type` and returns 0+ structured
// events for the main event queue.
//
// Kept as its own module (rather than inlined into main-server.js)
// specifically so new IPC message types can ship via hot-reload: adding
// a `case "new_message_type"` here only requires bumping cbgVersion,
// not restarting the daemon.
//
// Never throws — unknown message types and non-object frames log via
// dbg() and return [] so the event loop stays healthy.
//
// ── Related files ──────────────────────────────────────────────────────
//
//   lib/ipc.js
//     The shared byte-level framing layer. Both this file's caller
//     (main-server.js) and the mcp-shim go through `parseIpcMessages`
//     so there is exactly ONE implementation of the wire format in the
//     codebase — no drift hazard, no duplicated JSON.parse.
//
//   event-generators/cli/helpers.js
//     Holds the CLI side of the cli_command round-trip this file
//     dispatches (see `sendCliCommand` there). That helper produces
//     the outbound frame; this file decodes it.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)

// ── Hook-event compaction helpers (inlined; previously hook-compact.js) ──
// Claude Code hook events arrive from event-generators/hooks/hook.js with
// the raw tool_input/tool_response payloads, which can be large. We keep
// only the fields downstream handlers actually consume and hard-cap
// string lengths so nothing megabyte-sized rides the IPC event queue.

function compactToolInput(toolInput) {
    if (!toolInput || typeof toolInput !== "object") {
        return "{}"
    }
    const compact = {}
    if (toolInput.file_path) { compact.file_path = toolInput.file_path }
    if (toolInput.command) { compact.command = String(toolInput.command).slice(0, 300) }
    if (toolInput.description) { compact.description = String(toolInput.description).slice(0, 100) }
    if (toolInput.pattern) { compact.pattern = String(toolInput.pattern).slice(0, 100) }
    if (toolInput.path) { compact.path = toolInput.path }
    if (toolInput.prompt) { compact.prompt = String(toolInput.prompt).slice(0, 200) }
    return JSON.stringify(compact)
}

function compactToolResponse(toolResponse) {
    return JSON.stringify(toolResponse ?? "").slice(0, 300)
}

function isToolError(toolResponse) {
    return !!(toolResponse && typeof toolResponse === "object" && toolResponse.error)
}

/**
 * Convert one parsed IPC message into 0+ events for the main queue.
 *
 * The caller (main-server.js's per-connection read loop) has already
 * framed the wire bytes via `parseIpcMessages` from lib/ipc.js, so
 * `msg` arrives as a decoded JSON value.
 *
 * @param {object} msg — parsed JSON payload (already validated by
 *   parseIpcMessages to be well-formed JSON, but not yet type-checked)
 * @param {Deno.UnixConn} conn — the connection the frame came from
 * @param {object} core — read-only access to chatState, chatSessions, ipcConns, etc
 * @returns {object[]} events to enqueue
 */
export function translateIpcMessage(msg, conn, core) {
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
        dbg("IPC-TR", "non-object message:", msg)
        return []
    }

    const now = Date.now()

    switch (msg.type) {
        case "register": {
            // Tag the conn as a long-lived shim conn so the ipc_respond
            // tooling refuses to close it even if a downstream effect
            // sets closeAfter:true by mistake. CLI clients never send
            // "register", so their conns stay untagged and close
            // normally after the one-shot reply.
            try {
                conn._cbgKind = "shim"
            } catch (e) {
                dbg("IPC-TR", "tag shim conn failed:", e)
            }
            return [{
                type: "session_register",
                ts: now,
                session: msg.session,
                _conn: conn,
            }]
        }

        case "unregister": {
            return [{
                type: "session_unregister",
                ts: now,
                sessionId: msg.sessionId,
                reason: "clean",
            }]
        }

        case "tool_request": {
            return [{
                type: "claude_channel_tool_request",
                ts: now,
                sessionId: msg.sessionId,
                requestId: msg.requestId,
                toolName: msg.name,
                args: msg.args,
                _conn: conn,
            }]
        }

        case "hook_event": {
            // hook.js forwards the raw Claude hook JSON in `data`. We
            // select/compact fields here so the wire format stays thin
            // and downstream handlers keep their existing event shape.
            const data = msg.data && typeof msg.data === "object" ? msg.data : {}
            const hookName = data.hook_event_name ?? null

            let eventType
            if (hookName === "Stop") {
                eventType = "claude_hook_stop"
            } else if (hookName === "PreToolUse") {
                eventType = "claude_hook_pre_tool_use"
            } else if (hookName === "PostToolUse") {
                eventType = "claude_hook_post_tool_use"
            } else {
                dbg("IPC-TR", "unknown hook:", hookName)
                return []
            }

            // Resolve claudePid -> shim sessionId by scanning chatSessions.
            // chatSessions is a plain keyed object, not a Map.
            let sessionId = null
            const sessions = core?.chatSessions
            if (sessions && msg.claudePid != null) {
                try {
                    for (const [sid, sess] of Object.entries(sessions)) {
                        if (sess && sess.pid === msg.claudePid) {
                            sessionId = sid
                            break
                        }
                    }
                } catch (e) {
                    dbg("IPC-TR", "chatSessions iteration failed:", e)
                }
            }

            return [{
                type: eventType,
                ts: now,
                sessionId,
                claudePid: msg.claudePid,
                toolName: data.tool_name ?? null,
                inputPreview: compactToolInput(data.tool_input),
                outputPreview: compactToolResponse(data.tool_response),
                isError: isToolError(data.tool_response),
                _conn: conn,
            }]
        }

        case "permission_request": {
            return [{
                type: "permission_request",
                ts: now,
                sessionId: msg.sessionId,
                requestId: msg.request_id,
                toolName: msg.tool_name,
                description: msg.description,
                inputPreview: msg.input_preview,
                _conn: conn,
            }]
        }

        case "set_title": {
            return [{
                type: "claude_channel_tool_request",
                ts: now,
                toolName: "set_title",
                sessionId: msg.sessionId,
                args: { title: msg.title },
                _conn: conn,
            }]
        }

        case "server_dump": {
            // Emitted by the shim's cbg_debug MCP tool. The handler
            // responds via ipc_respond with a proper tool_response —
            // does NOT closeAfter, so the shim conn stays alive.
            return [{
                type: "server_dump",
                ts: now,
                source: msg.source ?? "mcp_tool",
                requestId: msg.requestId,
                sessionId: msg.sessionId ?? null,
                targetPath: msg.targetPath ?? null,
                _conn: conn,
            }]
        }

        case "cli_command": {
            return [{
                type: "cli_command",
                ts: now,
                kind: msg.kind,
                payload: msg.payload ?? {},
                _conn: conn,
            }]
        }

        case "long_task_definition_submitted": {
            return [{
                type: "long_task_definition_submitted",
                ts: now,
                sessionId: msg.sessionId,
                requestId: msg.requestId,
                taskId: msg.taskId,
                definition: msg.definition,
                _conn: conn,
            }]
        }

        case "scheduled_task_definition_submitted": {
            return [{
                type: "scheduled_task_definition_submitted",
                ts: now,
                sessionId: msg.sessionId,
                requestId: msg.requestId,
                scheduleTaskId: msg.scheduleTaskId,
                rule: msg.rule,
                definitionOfDone: msg.definitionOfDone,
                title: msg.title ?? null,
                _conn: conn,
            }]
        }

        default: {
            dbg("IPC-TR", "unknown message type:", msg.type)
            return []
        }
    }
}
