// ---------------------------------------------------------------------------
// lib/ipc.js — CBG's Unix-socket wire format.
//
// The ENTIRE wire format — encode, decode, and one shared sentinel — lives
// in this file. Nothing else. If a new rule about framing ever enters the
// codebase (length prefixes, a second separator, etc.), this is where it
// goes, and only callers that actually read/write raw bytes need to know.
//
// Callers do NOT get a "please send a message for me" helper. If you need
// to push a frame onto a connection, you write:
//
//     await conn.write(encodeIpcFrame(msg))
//
// at your own call site, with whatever error handling and sync/async
// semantics suit your context. That's deliberate: the three previous
// callers each wanted slightly different behavior (fire-and-forget,
// await-and-propagate, swallow-sync-errors-only), and a one-size-fits-all
// `sendIpc()` ended up masking an async-error leak in one caller and
// double-handling in another. Inlining the writes put that decision back
// where the context is.
//
// ── Exports ────────────────────────────────────────────────────────────
//
//   - encodeIpcFrame(msg) → Uint8Array
//       Pure encoder. The ONE place the framing format ("JSON + \n")
//       is defined. Used by:
//         * event-generators/cli/helpers.js         (CLI → daemon
//                                                    one-shot request)
//         * event-generators/hooks/hook.js          (awaits its own write)
//         * event-generators/mcp-server/mcp-shim.js (local fire-and-
//                                                    forget wrapper)
//         * lib/effects/channel-event.js            (awaits inside an
//                                                    already-async effect)
//         * lib/effects/filesystem.js               (sync write, loop
//                                                    over shim conns)
//
//   - parseIpcMessages(buf, chunk) → { messages, remaining }
//       Stream parser for an accumulating buffer. Used by the mcp-shim's
//       read loop and by main-server.js's per-connection listener — so
//       there is exactly ONE implementation of the wire format in the
//       codebase and no chance of drift between the two directions.
//
//   - UNKNOWN_CLAUDE_PID (constant)
//       Wire sentinel the hook script sends when the ancestor `claude`
//       PID can't be resolved. The server's fail-safe path surfaces any
//       hook tagged with this value regardless of focus. Producer: hook.js.
//
// ── Related files ──────────────────────────────────────────────────────
//
//   lib/ipc-inbound.js
//     Server-side INBOUND dispatch. Takes a parsed msg object (from
//     parseIpcMessages) and returns 0+ events for the main event loop.
//     Kept as its own module (not inlined into main-server.js) so new
//     IPC message types can ship via hot-reload.
//
//   event-generators/cli/helpers.js
//     Holds `sendCliCommand`, the CLI-side OUTBOUND one-shot
//     request/response helper. Previously lived in its own file
//     (ipc-client.js) but had exactly two callers (onboard and
//     authorize), both now consolidated into helpers.js.
// ---------------------------------------------------------------------------

import { versionedImport } from "./version.js"

const { dbg } = await versionedImport("./logging.js", import.meta)

const encoder = new TextEncoder()

/**
 * Sentinel sent in hook events when the Claude PID can't be determined.
 * The server fail-safes by displaying any hook tagged with this value
 * regardless of which session is currently focused. Producers: hook.js.
 */
export const UNKNOWN_CLAUDE_PID = "UNKNOWN"

/**
 * Encode a message into one newline-delimited JSON frame. Pure and
 * synchronous — the single place the wire format is defined.
 */
export function encodeIpcFrame(msg) {
    return encoder.encode(JSON.stringify(msg) + "\n")
}

/**
 * Parse newline-delimited JSON from an accumulating buffer.
 *
 * Append `chunk` to `buf`, split on `\n`, try to `JSON.parse` each
 * complete line, and return the parsed messages plus whatever bytes
 * are left in-flight (the tail after the last `\n`).
 *
 * Empty lines are silently skipped. Malformed lines log via dbg and
 * are dropped so the caller's read loop stays healthy.
 *
 * Call with a stateful `TextDecoder({ stream: true })` in the caller's
 * read loop — otherwise a multi-byte UTF-8 glyph split across a read
 * boundary will decode as two replacement characters.
 */
export function parseIpcMessages(buf, chunk) {
    buf += chunk
    const messages = []
    let nl
    while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line) { continue }
        try {
            messages.push(JSON.parse(line))
        } catch (e) {
            dbg("IPC", "parseIpcMessages: skipping malformed line:", e)
        }
    }
    return { messages, remaining: buf }
}
