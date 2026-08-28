// ---------------------------------------------------------------------------
// lib/ipc.js — CBG's Unix-socket wire format.
//
// The ENTIRE wire format — encode, decode, and one shared sentinel — lives
// in this file. Nothing else. If a new rule about framing ever enters the
// codebase (length prefixes, a second separator, etc.), this is where it
// goes, and only callers that actually read/write raw bytes need to know.
//
// To push a frame onto a connection, you write:
//
//     await writeIpcFrame(conn, msg)
//
// Callers used to inline `conn.write(encodeIpcFrame(msg))` so each could
// pick its own error handling. That scattered a WIRE-FORMAT rule — "a
// frame is only sent once every byte of it is sent" — across eight call
// sites, and seven got it wrong: `conn.write()` returns a SHORT COUNT
// when the kernel socket buffer is partially full, so any frame over
// ~8 KB was silently truncated mid-JSON. The receiver was then left
// holding a newline-less half-line, glued the NEXT frame onto it, and
// lost that one too before resyncing. Framing rules belong in this file,
// so the write loop lives here now.
//
// ── Exports ────────────────────────────────────────────────────────────
//
//   - encodeIpcFrame(msg) → Uint8Array
//       Pure encoder. The ONE place the framing format ("JSON + \n")
//       is defined. Prefer writeIpcFrame; reach for this directly only
//       when you need the bytes without a connection to write them to.
//
//   - writeIpcFrame(conn, msg) → Promise<void>
//       Encode and write one whole frame, retrying short writes.
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
//   lib/pure/ipc-inbound.js
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
 * Write one complete frame to a connection.
 *
 * `conn.write()` resolves as soon as the kernel accepts SOME of the
 * bytes, so a single call is only enough for frames that fit in the
 * socket buffer. Anything larger has to be retried from the offset it
 * stopped at, or the receiver gets a truncated line.
 *
 * Throws on write errors so the caller can decide whether the frame
 * mattered. Fire-and-forget callers should attach a `.catch` that logs
 * via dbg rather than dropping the rejection.
 */
export async function writeIpcFrame(conn, msg) {
    const data = encodeIpcFrame(msg)
    let written = 0
    while (written < data.length) {
        const n = await conn.write(data.subarray(written))
        if (n <= 0) {
            throw new Error(`ipc write stalled at ${written}/${data.length}B (write returned ${n})`)
        }
        written += n
    }
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
