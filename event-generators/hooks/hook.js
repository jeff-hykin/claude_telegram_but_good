// Claude Code PreToolUse / PostToolUse / Stop hook — forwards the full
// hook JSON to the cbg server over paths.IPC_SOCK, one write per invocation,
// then exits. All field selection, truncation, and formatting lives on
// the server (lib/pure/ipc-inbound.js + the claude_hook_* event handlers).
//
// Input (read from stdin, written by Claude Code — forwarded verbatim
// in the `data` field of the outbound IPC frame):
//     {
//         "hook_event_name": "PreToolUse" | "PostToolUse" | "Stop",
//         "tool_name":       "<Bash|Read|Edit|...>",     // absent on Stop
//         "session_id":      "<claude session uuid>",
//         "tool_input":      { ... },                    // tool-specific
//         "tool_response":   { error?, ... }             // PostToolUse only
//     }
//
// Output (single newline-terminated JSON frame to the Unix socket at
// paths.IPC_SOCK):
//     {
//         "type":      "hook_event",
//         "claudePid": <number>  // PID of the ancestor `claude` process
//                    | "UNKNOWN" // UNKNOWN_CLAUDE_PID sentinel when the
//                                // ancestor walk can't find a real
//                                // claude process; server's fail-safe
//                                // path still surfaces the event
//         "data":      { /* raw Claude hook JSON above, verbatim */ }
//                    | null      // set when stdin wasn't valid JSON
//     }
//
// The write is fire-and-forget with a 500 ms read deadline for the
// optional ack; failures are logged via dbg() and swallowed so a stalled
// daemon never blocks Claude Code's tool pipeline.

import { paths } from "../../lib/paths.js"
import { dbg } from "../../lib/logging.js"
import { findClaudePidStrict } from "../../lib/pid.js"
import { encodeIpcFrame, UNKNOWN_CLAUDE_PID } from "../../lib/ipc.js"

// Strict lookup so we never send a guessed/fallback PID. If the ancestor
// walk can't find a real claude process, tag with the UNKNOWN sentinel
// so the server's fail-safe path still surfaces the event.
const found = findClaudePidStrict(Deno.pid)
const claudePid = found ?? UNKNOWN_CLAUDE_PID
if (found == null) {
    dbg("HOOK", "claude PID not found in ancestry, sending UNKNOWN sentinel")
}

const input = await new Response(Deno.stdin.readable).text()

let data = null
try {
    data = JSON.parse(input)
} catch (e) {
    dbg("HOOK", `JSON parse failed: ${e instanceof Error ? e.message : String(e)}`)
}

dbg(
    "HOOK",
    "hook:", data?.hook_event_name ?? null,
    "tool:", data?.tool_name ?? null,
    "session:", data?.session_id ?? null,
)

// AskUserQuestion can't be answered in a channel-driven session, so the
// daemon decides whether to deny it (deny iff this claudePid is a registered
// cbg session). For that one tool we wait for the daemon's decision frame and,
// if told to, emit a PreToolUse "deny" so Claude blocks the call and shows the
// reason to the model. Every other hook stays fire-and-forget.
const isAskUserQuestion = data?.hook_event_name === "PreToolUse" && data?.tool_name === "AskUserQuestion"

/**
 * Read one newline-delimited JSON frame from `conn`, bounded by an overall
 * deadline. Returns the parsed object, or null on timeout / parse failure.
 */
async function readDecision(conn, timeoutMs) {
    const decoder = new TextDecoder()
    let acc = ""
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        const remaining = timeoutMs - (Date.now() - start)
        const buf = new Uint8Array(4096)
        const n = await Promise.race([
            conn.read(buf),
            new Promise((resolve) => setTimeout(() => resolve("TIMEOUT"), remaining)),
        ])
        if (n === "TIMEOUT" || n === null) { break }
        acc += decoder.decode(buf.subarray(0, n))
        const nl = acc.indexOf("\n")
        if (nl >= 0) {
            try {
                return JSON.parse(acc.slice(0, nl))
            } catch (e) {
                dbg("HOOK", "decision parse failed:", e)
                return null
            }
        }
    }
    return null
}

try {
    const conn = await Deno.connect({ transport: "unix", path: paths.IPC_SOCK })
    await conn.write(encodeIpcFrame({ type: "hook_event", claudePid, data }))

    if (isAskUserQuestion) {
        // Do NOT closeWrite() here: closing our write half makes the daemon's
        // read loop hit EOF and close the whole conn (its FD-leak guard)
        // before it can send the decision back, so the response write fails
        // with BadResource. The daemon parses our newline-framed message
        // without needing EOF, so leaving the write half open is fine. We
        // close fully once we've read the reply.
        // 3s budget keeps us under the 5s hook timeout even after deno
        // startup + the ancestry ps walk. Normal daemon response is sub-100ms.
        const decision = await readDecision(conn, 3000)
        try { conn.close() } catch (e) { dbg("HOOK", "close failed:", e) }
        if (decision?.deny) {
            console.log(JSON.stringify({
                hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "deny",
                    permissionDecisionReason: decision.reason
                        ?? "AskUserQuestion is not available in this session; ask the user via the reply tool instead.",
                },
            }))
        }
        // No decision (timeout / not a cbg session / daemon down) → stay
        // silent so Claude proceeds normally (fail open).
        Deno.exit(0)
    }

    // Fire-and-forget for every other hook: signal completion with a write
    // half-close, wait briefly for an optional ack, then close.
    try { await conn.closeWrite() } catch (e) { dbg("HOOK", "closeWrite failed:", e) }
    const buf = new Uint8Array(1)
    await Promise.race([
        conn.read(buf),
        new Promise(r => setTimeout(r, 500)),
    ])
    conn.close()
} catch (e) {
    dbg("HOOK", `IPC send failed: ${e instanceof Error ? e.message : String(e)}`)
}
