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

try {
    const conn = await Deno.connect({ transport: "unix", path: paths.IPC_SOCK })
    await conn.write(encodeIpcFrame({ type: "hook_event", claudePid, data }))
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
