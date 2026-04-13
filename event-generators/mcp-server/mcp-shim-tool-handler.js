/**
 * event-generators/mcp-server/mcp-shim-tool-handler.js
 *
 * Reloadable tool-call logic for the MCP shim. Every CallToolRequest
 * goes through `handleToolCall(req, ctx)` here. The thin mcp-shim.js
 * re-imports this file via versionedImport for every call, so bumping
 * globalThis.cbgVersion gets fresh behavior mid-session.
 *
 * The `ctx` parameter carries the shim's stable state (sessionId,
 * serverConn, pendingToolCalls map, and a few callbacks). Handlers
 * should never mutate ctx beyond what's in the interface below.
 *
 * Adding a new tool NAME still requires a session restart because the
 * MCP tool list is queried once at MCP server boot. This file owns
 * that list (TOOLS export) + the handler logic.
 */

import { versionedImport } from "../../lib/version.js"

const { dbg } = await versionedImport("../../lib/logging.js", import.meta)
const { getToolCallTimeoutMs } = await versionedImport("../../lib/config-manager.js", import.meta)

// ── Tool list ─────────────────────────────────────────────────────────
// This is what Claude Code sees. Frozen at session startup.
export const TOOLS = [
    {
        name: "reply",
        description: "Reply on Telegram. Pass chat_id from the inbound message. Optionally pass reply_to (message_id) for threading, and files (absolute paths) to attach images or documents.",
        inputSchema: {
            type: "object",
            properties: {
                chat_id: { type: "string" },
                text: { type: "string" },
                reply_to: { type: "string", description: "Message ID to thread under." },
                files: { type: "array", items: { type: "string" }, description: "Absolute file paths to attach." },
                format: {
                    type: "string",
                    enum: ["text", "html", "markdownv2"],
                    description: "Rendering mode. Default: 'text'. Use 'html' for <b>, <i>, <code>, <pre> formatting.",
                },
            },
            required: ["chat_id", "text"],
        },
    },
    {
        name: "react",
        description: "Add an emoji reaction to a Telegram message.",
        inputSchema: {
            type: "object",
            properties: {
                chat_id: { type: "string" },
                message_id: { type: "string" },
                emoji: { type: "string" },
            },
            required: ["chat_id", "message_id", "emoji"],
        },
    },
    {
        name: "download_attachment",
        description: "Download a file attachment from a Telegram message to the local inbox.",
        inputSchema: {
            type: "object",
            properties: {
                file_id: { type: "string", description: "The attachment_file_id from inbound meta" },
            },
            required: ["file_id"],
        },
    },
    {
        name: "edit_message",
        description: "Edit a message the bot previously sent. Edits don't trigger push notifications.",
        inputSchema: {
            type: "object",
            properties: {
                chat_id: { type: "string" },
                message_id: { type: "string" },
                text: { type: "string" },
                format: { type: "string", enum: ["text", "html", "markdownv2"] },
            },
            required: ["chat_id", "message_id", "text"],
        },
    },
    {
        name: "set_title",
        description: "Set a display title for this session in the Telegram /list view.",
        inputSchema: {
            type: "object",
            properties: {
                title: { type: "string", description: "Short title for this session" },
            },
            required: ["title"],
        },
    },
    {
        name: "reload",
        description: "Hot-reload command handlers from the commands/ directory.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "new_command",
        description: "Create or update a custom Telegram bot command and hot-reload it immediately. The file must export `commands[name]: (event, core) => Action`, where Action is `{ stateChanges?, effects?, followUpEvents? }`. Example: `export const commands = { hi: (event) => ({ effects: [{ type: 'send_text_to_user', chatId: event.chatId, text: 'hello' }] }) }`. See commands/ping.js in the CBG repo for the simplest reference.",
        inputSchema: {
            type: "object",
            properties: {
                filename: { type: "string", description: 'Filename (e.g. "mycommand.js"). Must end in .js.' },
                code: { type: "string", description: "Full JavaScript source code for the command file. Must export `commands` as an object whose values are `(event, core) => Action` functions returning `{ stateChanges?, effects?, followUpEvents? }`." },
            },
            required: ["filename", "code"],
        },
    },
    {
        name: "submit_long_task_definition",
        description: "Submit the definition of done for your current long task. Fails if you don't have an active task or if the definition has already been submitted.",
        inputSchema: {
            type: "object",
            properties: {
                taskId: { type: "string" },
                definition: { type: "string", description: "Markdown definition of done" },
            },
            required: ["taskId", "definition"],
        },
    },
    {
        name: "cbg_debug",
        description: "Returns the path to the CBG server log and a fresh server state dump for debugging.",
        inputSchema: { type: "object", properties: {} },
    },
]

// ── Tool dispatch ─────────────────────────────────────────────────────
//
// Every tool call maps to an IPC message type that the main-server
// handles as an event. We send it, register a pending-call entry, and
// await the matching tool_response message from the server.
//
// If the call is purely local (like set_title, which doesn't need the
// server to do anything beyond remembering the title), we can handle
// it synchronously in this file.

/**
 * Dispatch a tool call. `ctx` is provided by shim.js — see the top of
 * this file for the interface.
 */
export async function handleToolCall(req, ctx) {
    const name = req.params?.name
    const args = req.params?.arguments ?? {}
    const { sessionId, serverConn, pendingToolCalls, randomHex, sendIpc, getOwnTitle, setOwnTitle } = ctx

    if (!name || typeof name !== "string") {
        return errorResult("missing tool name")
    }

    dbg("SHIM-TOOL", `handleToolCall: ${name}`)

    // Local-only: set_title updates the shim's own state AND notifies server.
    if (name === "set_title") {
        const title = String(args.title ?? "").trim()
        setOwnTitle(title)
        if (serverConn) {
            sendIpc(serverConn, { type: "set_title", sessionId, title })
        }
        return okResult(`title set: ${title}`)
    }

    // Everything else requires a live server connection.
    if (!serverConn) {
        return errorResult(`${name} failed: not connected to CBG server`)
    }

    // Translate the MCP tool call into an IPC message type the
    // main-server's event translator understands. Most tools map to
    // the generic `claude_channel_tool_request` translator path.
    const requestId = randomHex(4)

    let ipcMessage
    if (name === "submit_long_task_definition") {
        ipcMessage = {
            type: "long_task_definition_submitted",
            sessionId,
            requestId,
            taskId: args.taskId,
            definition: args.definition,
        }
    } else if (name === "cbg_debug") {
        // server_dump event (not cli_command!) — the dedicated MCP path.
        // cli_command routes close the connection after replying, which
        // would kill the shim's long-lived IPC conn. The server_dump
        // handler's "mcp_tool" branch sends a proper tool_response back
        // without closing.
        ipcMessage = {
            type: "server_dump",
            source: "mcp_tool",
            requestId,
            sessionId,
        }
    } else {
        // reply, react, download_attachment, edit_message, reload, new_command
        ipcMessage = {
            type: "tool_request",
            requestId,
            sessionId,
            name,
            args,
        }
    }

    return await awaitToolReply({
        ipcMessage,
        requestId,
        pendingToolCalls,
        sendIpc,
        serverConn,
        toolName: name,
    })
}

function awaitToolReply({ ipcMessage, requestId, pendingToolCalls, sendIpc, serverConn, toolName }) {
    const timeoutMs = getToolCallTimeoutMs()
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            if (pendingToolCalls.has(requestId)) {
                pendingToolCalls.delete(requestId)
                resolve(errorResult(`${toolName} timed out after ${timeoutMs}ms`))
            }
        }, timeoutMs)

        pendingToolCalls.set(requestId, {
            resolve: (result) => {
                clearTimeout(timer)
                resolve(result)
            },
            reject: (err) => {
                clearTimeout(timer)
                resolve(errorResult(`${toolName} failed: ${err?.message ?? String(err)}`))
            },
        })

        try {
            sendIpc(serverConn, ipcMessage)
        } catch (e) {
            clearTimeout(timer)
            pendingToolCalls.delete(requestId)
            resolve(errorResult(`${toolName} send failed: ${e?.message ?? String(e)}`))
        }
    })
}

// ── Channel event handler ─────────────────────────────────────────────
// Called when main-server forwards an inbound Telegram message.
//
// NOTE: the method string MUST be exactly `notifications/claude/channel`.
// This is what the official telegram plugin's server.ts uses (see its
// line ~958) and it's the only method Claude Code listens for on the
// --channels wire. Any other method — including the old
// `/channel/message` suffix this shim briefly used — is silently dropped
// by the client and the message never reaches the agent.
export async function handleChannelEvent(msg, mcp) {
    try {
        await mcp.notification({
            method: "notifications/claude/channel",
            params: {
                content: msg.content,
                meta: msg.meta,
            },
        })
        dbg("SHIM-TOOL", `channel notification delivered (${(msg.content ?? "").length} chars)`)
    } catch (e) {
        dbg("SHIM-TOOL", "channel notification failed:", e)
    }
}

// ── Result helpers ────────────────────────────────────────────────────
function okResult(text) {
    return { content: [{ type: "text", text }] }
}

function errorResult(text) {
    return { content: [{ type: "text", text }], isError: true }
}
