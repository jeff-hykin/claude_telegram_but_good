#!/usr/bin/env -S deno run -A
/**
 * event-generators/mcp-server/mcp-shim.js
 *
 * Thin MCP shim that Claude Code loads as an MCP server, one per session.
 * This file stays STABLE across CBG updates — it's the bootstrap that
 * enables hot reload of the underlying tool-call logic.
 *
 * Named `mcp-shim.js` (not `shim.js`) to disambiguate from the CLAUDE
 * CLI shim at event-generators/cli/shim-setup.js, which is an entirely
 * different thing — a bash wrapper installed at $PATH/claude to
 * intercept the `claude` command. See that file's header for details.
 *
 * Responsibilities (stable, rarely changes):
 *   1. Register the fixed set of MCP tools with Claude Code.
 *   2. Maintain a single long-lived IPC connection to main-server.js.
 *   3. Register this session via `{ type: "register", session: {...} }`.
 *   4. For every CallToolRequest, dynamically import mcp-shim-tool-handler.js
 *      at the current globalThis.cbgVersion and delegate to it.
 *   5. Forward channel_event notifications from the server to Claude.
 *   6. Unregister cleanly on shutdown.
 *   7. On boot, call setup.js's ensureOfficialPluginPatched() to
 *      self-heal the upstream plugin's .mcp.json files whenever a
 *      drifted version is detected.
 *
 * Sibling files under event-generators/mcp-server/:
 *   - mcp-shim-tool-handler.js — reloadable tool-call logic (hot-reloadable)
 *   - setup.js — install + drift self-heal of the .mcp.json files
 *     Claude Code uses to locate and launch this shim
 *
 * NOTE: The set of MCP tool NAMES and their input schemas is frozen at
 * startup — Claude Code queries the tool list once when the MCP server
 * boots. Adding a new tool requires restarting the session. Tool
 * HANDLERS can change freely via hot reload.
 */

import { versionedImport, VERSION } from "../../lib/version.js"
import {
    McpServer, StdioServerTransport,
    ListToolsRequestSchema, CallToolRequestSchema,
    join, sibling,
} from "../../imports.js"

// Initialize globalThis.cbgVersion from the VERSION constant. The shim
// itself doesn't reload, but the tool handler it delegates to IS
// reloadable via versionedImport + cbgVersion.
globalThis.cbgVersion = VERSION

// ── Paths and utilities (imported via versionedImport) ────────────────
const [
    { paths },
    { dbg },
    { encodeIpcFrame, parseIpcMessages },
    { randomHex, generateName },
    { findClaudePid },
    { ensureOfficialPluginPatched },
] = await Promise.all([
    versionedImport("../../lib/paths.js", import.meta),
    versionedImport("../../lib/logging.js", import.meta),
    versionedImport("../../lib/ipc.js", import.meta),
    versionedImport("../../lib/pure/ids.js", import.meta),
    versionedImport("../../lib/pid.js", import.meta),
    versionedImport("./setup.js", import.meta),
])

// Local shim→server write helper. Previously imported from lib/ipc.js
// as `sendIpc`; that helper moved into each of its callers because the
// right error-handling shape differs by context. The shim's context:
// fire-and-forget, swallow errors, log and continue. We keep the name
// `sendIpc` so the ctx object we pass into mcp-shim-tool-handler.js
// can stay byte-identical — the tool handler doesn't know (or care)
// that sendIpc is now a local closure instead of a library import.
function sendIpc(conn, msg) {
    try {
        conn.write(encodeIpcFrame(msg))
    } catch (e) {
        dbg("SHIM-IPC", "write failed:", e)
    }
}

// ── Drift self-heal ───────────────────────────────────────────────────
// Claude Code drops a new unpatched .mcp.json into a new versioned cache
// dir whenever the upstream telegram@claude-plugins-official plugin
// updates. Any cbg-patched shim that runs repatches every cached .mcp.json
// so the next claude launch has a chance of picking a patched one again.
//
// Opportunistic (not a full fix): if Claude Code happens to pick the
// *unpatched* version after an upgrade, the cbg shim doesn't run and the
// heal can't fire. But once *any* patched version runs, every cache dir
// gets repatched, so drift clears on the next launch that picks the
// patched one. Wrapped in try/catch so a transient failure can never
// prevent shim startup.
try {
    const result = ensureOfficialPluginPatched()
    if (result?.patched?.length > 0) {
        dbg("SHIM", `drift heal: repatched ${result.patched.length} .mcp.json file(s)`)
    }
} catch (e) {
    dbg("SHIM", "drift heal failed (non-fatal):", e)
}

// ── Session identity ──────────────────────────────────────────────────
// Read the pre-assigned session id (set by cbg new) if available;
// otherwise generate a fresh one.
const SESSION_ID = (() => {
    try {
        const raw = Deno.readTextFileSync(paths.NEXT_SESSION_FILE)
        const data = JSON.parse(raw)
        Deno.removeSync(paths.NEXT_SESSION_FILE)
        if (data.id) {
            if (data.title) { Deno.env.set("TELEGRAM_SESSION_TITLE", data.title) }
            if (data.dtachSocket) { Deno.env.set("TELEGRAM_DTACH_SOCKET", data.dtachSocket) }
            return data.id
        }
    } catch (err) {
        dbg("SHIM", "next_session.json not found or error:", String(err))
    }
    return generateName()
})()

const SESSION_START = Date.now()
const SESSION_CWD = Deno.env.get("SESSION_CWD") ?? Deno.cwd()
const SESSION_PID = findClaudePid(Deno.pid)
const SESSION_DTACH_SOCKET = Deno.env.get("TELEGRAM_DTACH_SOCKET") ?? Deno.env.get("CBG_DTACH_SOCKET") ?? undefined
const IN_DTACH = !!(Deno.env.get("CBG_DTACH") || SESSION_DTACH_SOCKET)

let ownTitle = Deno.env.get("TELEGRAM_SESSION_TITLE") ?? null
let ownGitBranch = (() => {
    try {
        const result = new Deno.Command("git", {
            args: ["rev-parse", "--abbrev-ref", "HEAD"],
            cwd: SESSION_CWD,
            stdout: "piped",
            stderr: "null",
        }).outputSync()
        return new TextDecoder().decode(result.stdout).trim() || null
    } catch (e) {
        dbg("SHIM", "git branch detect failed:", e)
        return null
    }
})()

function ownSessionInfo() {
    return {
        id: SESSION_ID,
        pid: SESSION_PID,
        cwd: SESSION_CWD,
        connectedAt: SESSION_START,
        title: ownTitle,
        gitBranch: ownGitBranch,
        dtachSocket: SESSION_DTACH_SOCKET,
        inDtach: IN_DTACH,
    }
}

// ── MCP server setup ───────────────────────────────────────────────────
// Tool LIST is frozen at startup (Claude Code queries once). Adding a
// new tool name requires restarting the session.

const PLUGIN_VERSION = (() => {
    try {
        return JSON.parse(
            Deno.readTextFileSync(sibling(import.meta, "../../.claude-plugin/plugin.json")),
        ).version
    } catch (e) {
        dbg("SHIM", "plugin.json read failed:", e)
        return "unknown"
    }
})()

const mcp = new McpServer(
    { name: "cbg-telegram", version: PLUGIN_VERSION },
    {
        capabilities: {
            tools: {},
            // The `experimental` block is load-bearing: without declaring
            // these custom notification namespaces the MCP SDK silently
            // drops any `mcp.notification({ method: "notifications/claude/channel..." })`
            // call, so inbound Telegram messages never reach the agent.
            // Matches the official telegram plugin's server.ts capabilities
            // block — keep in sync.
            experimental: {
                "claude/channel": {},
                "claude/channel/permission": {},
            },
        },
    },
)

// Pending tool calls awaiting IPC replies from main-server.
const pendingToolCalls = new Map()  // requestId → { resolve, reject }

// ── Permission request handling ──────────────────────────────────────
// Claude Code sends `notifications/claude/channel/permission_request`
// when it needs user approval for a tool call. We forward this to the
// main-server via IPC, which sends a Telegram message with Allow/Deny
// buttons. The server replies with `permission_reply` over IPC, and
// we forward it back to Claude Code as a `notifications/claude/channel/permission`.
// setNotificationHandler expects a Zod schema; use the internal map directly
// for custom notification methods that have no pre-built schema.
mcp._notificationHandlers.set(
    "notifications/claude/channel/permission_request",
    async (notification) => {
        const params = notification.params ?? {}
        dbg("SHIM", `permission_request: tool=${params.tool_name} req=${params.request_id}`)
        if (!serverConn) {
            dbg("SHIM", "permission_request: no server connection — cannot forward")
            return
        }
        try {
            sendIpc(serverConn, {
                type: "permission_request",
                sessionId: SESSION_ID,
                request_id: params.request_id,
                tool_name: params.tool_name,
                description: params.description ?? "",
                input_preview: params.input_preview ?? "",
            })
        } catch (e) {
            dbg("SHIM", "permission_request forward failed:", e)
        }
    },
)

// Register the full tool list. The mcp-shim-tool-handler dispatch uses
// these names — keep them in sync if you add handlers there.
mcp.setRequestHandler(ListToolsRequestSchema, async () => {
    const { TOOLS } = await versionedImport("./mcp-shim-tool-handler.js", import.meta)
    return { tools: TOOLS }
})

// Delegate every tool call to the reloadable handler.
mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { handleToolCall } = await versionedImport("./mcp-shim-tool-handler.js", import.meta)
    return await handleToolCall(req, {
        sessionId: SESSION_ID,
        serverConn,
        pendingToolCalls,
        randomHex,
        sendIpc,
        dbg,
        getOwnTitle: () => ownTitle,
        setOwnTitle: (t) => { ownTitle = t },
    })
})

// ── IPC connection to main-server.js ──────────────────────────────────
let serverConn = null
let readBuffer = ""

async function connectToServer() {
    return await Deno.connect({ transport: "unix", path: paths.IPC_SOCK })
}

async function ensureServerRunning() {
    try {
        const probe = await connectToServer()
        probe.close()
        return
    } catch (e) {
        dbg("SHIM", "server probe failed, will check paths.STOPPED_FILE:", e)
    }
    try {
        Deno.statSync(paths.STOPPED_FILE)
        dbg("SHIM", "server.stopped file present — not spawning")
        return
    } catch (e) {
        dbg("SHIM", "no paths.STOPPED_FILE, server genuinely down:", e)
    }
    // v1: don't auto-spawn from the new shim. The user or cbg CLI
    // starts main-server.js explicitly. Log and move on.
    dbg("SHIM", "main-server.js is not running; tool calls will fail until it starts")
}

// Tunables for the reconnect loop. If the daemon is down we back off
// exponentially up to RECONNECT_MAX_MS; on success we reset the delay.
const RECONNECT_INITIAL_MS = 2_000
const RECONNECT_MAX_MS = 30_000
let reconnectDelayMs = RECONNECT_INITIAL_MS
// Hoisted up from the shutdown block below so scheduleReconnect can
// reference it without tripping a let-TDZ error. scheduleReconnect may
// run via setTimeout before module evaluation reaches the original
// declaration site.
let shuttingDown = false

async function connectAndRegister() {
    await ensureServerRunning()
    try {
        serverConn = await connectToServer()
        dbg("SHIM", "connected to main-server")
    } catch (e) {
        dbg("SHIM", "connect failed:", e)
        scheduleReconnect()
        return
    }
    reconnectDelayMs = RECONNECT_INITIAL_MS
    sendIpc(serverConn, { type: "register", session: ownSessionInfo() })

    // Read loop for incoming IPC messages from main-server.
    ;(async () => {
        const decoder = new TextDecoder()
        const buf = new Uint8Array(8192)
        while (true) {
            let n
            try {
                n = await serverConn.read(buf)
            } catch (e) {
                dbg("SHIM", "read error:", e)
                break
            }
            if (n == null) { break }
            const { messages, remaining } = parseIpcMessages(readBuffer, decoder.decode(buf.subarray(0, n)))
            readBuffer = remaining
            for (const msg of messages) {
                await handleServerMessage(msg)
            }
        }
        dbg("SHIM", "IPC read loop ended")
        serverConn = null
        readBuffer = ""
        scheduleReconnect()
    })()
}

// Schedule another connectAndRegister after a backoff delay. Called
// whenever the IPC socket to main-server drops (either a failed connect
// or a mid-life read-loop EOF). Without this the shim goes permanently
// dead from the daemon's POV on every daemon restart, which is what
// makes old sessions pile up as zombies in /list.
function scheduleReconnect() {
    if (shuttingDown) { return }
    const delay = reconnectDelayMs
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS)
    dbg("SHIM", `reconnect scheduled in ${delay}ms`)
    setTimeout(() => {
        if (shuttingDown) { return }
        connectAndRegister().catch(e => {
            dbg("SHIM", "reconnect attempt threw:", e)
            scheduleReconnect()
        })
    }, delay)
}

async function handleServerMessage(msg) {
    if (msg.type === "tool_response") {
        const pending = pendingToolCalls.get(msg.requestId)
        if (pending) {
            pendingToolCalls.delete(msg.requestId)
            pending.resolve(msg.result)
        } else {
            dbg("SHIM", "tool_response for unknown requestId:", msg.requestId)
        }
        return
    }
    if (msg.type === "channel_event") {
        // A message arrived from Telegram routed to this session.
        // Dispatch to the reloadable handler so its logic can change.
        try {
            const { handleChannelEvent } = await versionedImport("./mcp-shim-tool-handler.js", import.meta)
            await handleChannelEvent(msg, mcp)
        } catch (e) {
            dbg("SHIM", "handleChannelEvent failed:", e)
        }
        return
    }
    if (msg.type === "permission_reply") {
        // User clicked Allow/Deny in Telegram — forward to Claude Code
        // as a `notifications/claude/channel/permission` notification.
        try {
            await mcp.notification({
                method: "notifications/claude/channel/permission",
                params: {
                    request_id: msg.request_id,
                    behavior: msg.behavior,
                },
            })
            dbg("SHIM", `permission_reply forwarded: req=${msg.request_id} behavior=${msg.behavior}`)
        } catch (e) {
            dbg("SHIM", "permission_reply notification failed:", e)
        }
        return
    }
    if (msg.type === "registered") {
        dbg("SHIM", `registered with main-server, focused=${msg.focusedId}`)
        return
    }
    if (msg.type === "version_bumped") {
        // main-server just rewrote lib/version.js. Update our in-memory
        // cbgVersion so the NEXT versionedImport("./mcp-shim-tool-handler.js")
        // produces a new URL (salted with the bumped version) and Deno
        // fetches a fresh copy. Already-loaded modules stay cached under
        // the OLD URL and are collected when nothing references them.
        if (typeof msg.version === "number" && msg.version > (globalThis.cbgVersion ?? 0)) {
            const prev = globalThis.cbgVersion
            globalThis.cbgVersion = msg.version
            dbg("SHIM", `version_bumped ${prev} -> ${msg.version}`)
        } else {
            dbg("SHIM", `version_bumped ignored (got ${msg.version}, have ${globalThis.cbgVersion})`)
        }
        return
    }
    dbg("SHIM", "unhandled server message type:", msg.type)
}

// ── Shutdown ──────────────────────────────────────────────────────────
// `shuttingDown` is declared earlier in the file (near the reconnect
// tunables) so scheduleReconnect can safely read it.
function shutdown() {
    if (shuttingDown) { return }
    shuttingDown = true
    dbg("SHIM", "shutting down")
    if (serverConn) {
        try {
            sendIpc(serverConn, { type: "unregister", sessionId: SESSION_ID })
            serverConn.close()
        } catch (e) {
            dbg("SHIM", "unregister/close failed:", e)
        }
    }
}
Deno.addSignalListener("SIGTERM", shutdown)
Deno.addSignalListener("SIGINT", shutdown)

// ── Go ────────────────────────────────────────────────────────────────
await connectAndRegister()

const transport = new StdioServerTransport()
await mcp.connect(transport)
dbg("SHIM", `MCP shim ready for session ${SESSION_ID} (plugin ${PLUGIN_VERSION}, cbg v${VERSION})`)
