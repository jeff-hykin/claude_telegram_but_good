// ---------------------------------------------------------------------------
// lib/agent-backends/spec.js — THE agent-backend interface spec.
//
// cbg drives an "agent": something that holds a conversation, calls tools,
// and finishes turns. Claude Code was the only agent for a long time, so
// its mechanics (dtach, a TUI, ~/.claude/settings.json hooks, the official
// telegram MCP plugin) leaked into the daemon. This file is the contract
// that ends that: Claude Code is now ONE implementation of the interface
// below, and a local model served by LM Studio is another.
//
// ── The contract has two halves ────────────────────────────────────────
//
// HALF A — the daemon-side backend module (this file's typedefs).
//   A plain object with async methods. The daemon calls these to spawn a
//   session, push text into it, interrupt it, read its screen, and tear it
//   down. Implementations live in lib/agent-backends/<name>.js and are
//   looked up through lib/agent-backends/index.js.
//
// HALF B — the session-side wire protocol (documented below).
//   Whatever process the backend spawns must talk newline-JSON over
//   paths.IPC_SOCK. This half is NOT new — it is exactly what the Claude
//   MCP shim and hook script already speak. Writing it down makes it a
//   contract instead of an accident, and it is the reason a second backend
//   is tractable at all: a session that speaks it inherits the spinner,
//   the nudge watchdog, long tasks, the critic, scheduled tasks, and
//   interval hooks with ZERO daemon changes.
//
// ── HALF B: the session-side wire protocol ─────────────────────────────
//
// Framing: newline-delimited JSON, see lib/ipc.js. Connect to
// paths.IPC_SOCK. Reconnect with backoff — the daemon restarts.
//
// SESSION → DAEMON
//
//   { type: "register", session: {
//         id,           // the pre-assigned session id from NEXT_SESSION_FILE
//         pid,          // OS pid used to correlate hook_event frames
//         cwd, title, gitBranch,
//         backend,      // NEW: which AgentBackend owns this session.
//                       // Omitted/undefined means "claude" (back-compat:
//                       // every shim in the wild predates this field).
//         dtachSocket,  // optional — only TUI backends have one
//         inDtach,      // optional
//     } }
//
//   { type: "unregister", sessionId, reason }
//
//   { type: "tool_request", requestId, sessionId, name, args }
//       The cbg tool surface: reply, react, edit_message,
//       download_attachment, reload, new_command, get_topic_memory,
//       list_sessions, tell_session, set_reminder, watch_file, ...
//       The daemon answers with { type: "tool_response", requestId, result }.
//       An agent backend is expected to expose these to its model — they
//       are how the agent talks to the user at all.
//
//   { type: "hook_event", claudePid, data: {
//         hook_event_name: "PreToolUse" | "PostToolUse" | "Stop",
//         tool_name, tool_use_id, tool_input, tool_response, session_id,
//     } }
//       TURN LIFECYCLE. This is the single most load-bearing frame in cbg
//       and the one thing a new backend MUST emit, because everything
//       downstream keys off it:
//         - PreToolUse/PostToolUse drive the spinner (paired by tool_use_id)
//         - Stop means "the agent finished its turn", which drives the reply
//           nudge, the long-task report nudge, the critic spawn, and the
//           message-queue drain.
//       The field is named `claudePid` for wire compatibility with the
//       existing hook script; it is really just "the pid I registered with".
//
//   { type: "set_title", sessionId, title }
//
// DAEMON → SESSION
//
//   { type: "registered", focusedId }
//   { type: "channel_event", content, meta }
//       An inbound user message routed to this session. The agent should
//       treat it as a new user turn.
//   { type: "tool_response", requestId, result }
//   { type: "version_bumped", version }
//   { type: "agent_input", text, kind }
//       NEW. The daemon's generic "say this to the agent" channel: nudges,
//       check-ins, queue drains, injected prompts. For Claude Code this is
//       delivered out-of-band by typing into the TUI through dtach, so the
//       Claude backend never sends this frame. Backends without a TUI
//       receive it here instead. `kind` is advisory ("nudge", "queue",
//       "prompt").
//
//   { type: "agent_control", action: "interrupt" | "kill" }
//       NEW, and the sibling of agent_input: out-of-band control rather
//       than conversation. Claude Code takes these as keystrokes (ESC to
//       interrupt), so its backend never sends this frame either.
//
// ── Writing a backend ──────────────────────────────────────────────────
//
// This spec covers the RUNTIME contract: spawn a session, talk to it,
// interrupt it, observe it, kill it. Install-time wiring is deliberately
// out of scope — it still lives in event-generators/cli/helpers.js, which
// installs Claude Code's hooks, .mcp.json patches, and skills during
// onboarding. The local backend needs no install step at all (it spawns
// its runner directly), so pulling that flow behind the interface would
// be churn with no payoff today. Revisit if a third backend needs it.
//
// Use `defineBackend({ ... })`. Anything you leave out becomes a method
// that reports "unsupported by <name>" rather than crashing the daemon —
// so a backend with no TUI simply omits readScreen/sendRawInput, and the
// commands that need them (/peek, /raw, /login) degrade with a clear
// message instead of throwing. Declare what you DO support in
// `capabilities` so callers can check before calling.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)

/**
 * What a backend can do. Callers check these before offering a feature;
 * every flag defaults to false so a new capability can be added here
 * without silently claiming existing backends have it.
 *
 * @typedef {object} AgentCapabilities
 * @property {boolean} rawInput        — accepts raw keystrokes (arrow keys, ESC)
 * @property {boolean} screen          — has a renderable screen for /peek
 * @property {boolean} slashCommands   — understands /compact, /model, /goal
 * @property {boolean} login           — has an interactive auth flow (/login)
 * @property {boolean} permissionPrompts — asks before running tools
 * @property {boolean} interrupt       — can cancel an in-flight turn
 * @property {boolean} contextUsage    — can report how much context it is carrying
 */
export const NO_CAPABILITIES = Object.freeze({
    rawInput: false,
    screen: false,
    slashCommands: false,
    login: false,
    permissionPrompts: false,
    interrupt: false,
    contextUsage: false,
})

/**
 * @typedef {object} SpawnRequest
 * @property {string} sessionId — pre-assigned id; the session MUST register under it
 * @property {string} [title]
 * @property {string} [cwd]
 * @property {string} [topicName] — if set, the topic memory dir is created
 * @property {string} [prompt]    — initial prompt, for headless/worker spawns
 *
 * @typedef {object} BackendResult
 * @property {boolean} ok
 * @property {string} [detail] — human-readable, surfaced to the user on failure
 *
 * @typedef {object} AgentBackend
 * @property {string} name
 * @property {string} description
 * @property {AgentCapabilities} capabilities
 * @property {(req: SpawnRequest) => Promise<BackendResult>} spawn
 * @property {(req: {session: object, text: string, kind?: string}) => Promise<BackendResult>} sendUserText
 * @property {(req: {session: object, filePaths: string[]}) => Promise<BackendResult>} sendFiles
 * @property {(req: {session: object, text: string, submit?: boolean, atomic?: boolean}) => Promise<BackendResult>} sendRawInput
 * @property {(req: {session: object}) => Promise<BackendResult>} interrupt
 * @property {(req: {session: object}) => Promise<BackendResult>} kill
 * @property {(req: {session: object, width?: number, height?: number}) => Promise<{ok: boolean, screen?: string, detail?: string}>} readScreen
 * @property {(req: {session: object}) => Promise<{ok: boolean, tokens?: number, limit?: number, percentUsed?: number, detail?: string}>} contextUsage
 * @property {() => Promise<{ok: boolean, detail?: string}>} healthCheck
 */

/** Every method a backend may implement, and its arity-0 fallback. */
const METHODS = [
    "spawn",
    "sendUserText",
    "sendFiles",
    "sendRawInput",
    "interrupt",
    "kill",
    "readScreen",
    "contextUsage",
    "healthCheck",
]

function unsupported(backendName, method) {
    return async () => {
        dbg("BACKEND", `${backendName}.${method} is not supported`)
        return { ok: false, detail: `${method} is not supported by the "${backendName}" agent backend` }
    }
}

/**
 * Build a complete AgentBackend from a partial definition. Missing
 * methods become clean "unsupported" responses; missing capabilities
 * default to false.
 *
 * @param {Partial<AgentBackend> & {name: string}} definition
 * @returns {AgentBackend}
 */
export function defineBackend(definition) {
    if (!definition?.name) {
        throw new Error("defineBackend: name is required")
    }
    const backend = {
        name: definition.name,
        description: definition.description ?? definition.name,
        capabilities: { ...NO_CAPABILITIES, ...(definition.capabilities ?? {}) },
    }
    for (const method of METHODS) {
        backend[method] = definition[method] ?? unsupported(definition.name, method)
    }
    return backend
}

/**
 * Assert an object satisfies the interface. Returns a list of problems —
 * empty means valid. Used by tests and by the registry at load time so a
 * malformed backend is caught at startup rather than mid-conversation.
 */
export function validateBackend(backend) {
    const problems = []
    if (!backend || typeof backend !== "object") {
        return ["not an object"]
    }
    if (typeof backend.name !== "string" || !backend.name) {
        problems.push("missing name")
    }
    for (const method of METHODS) {
        if (typeof backend[method] !== "function") {
            problems.push(`missing method: ${method}`)
        }
    }
    for (const flag of Object.keys(NO_CAPABILITIES)) {
        if (typeof backend.capabilities?.[flag] !== "boolean") {
            problems.push(`missing capability flag: ${flag}`)
        }
    }
    return problems
}
