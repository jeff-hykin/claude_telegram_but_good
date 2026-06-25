// ---------------------------------------------------------------------------
// lib/pure/disconnect-scan.js
//
// Detects the Claude Code TUI's API-reconnect banner in a session's
// rendered screen. When Claude loses its connection to the Anthropic API
// it shows a line like:
//
//     ⎿  Retrying in 0s · attempt 7/10
//
// We render the tail of the raw dtach log through the same VT100 emulator
// `/peek` uses (so we only see what is CURRENTLY on screen, not stale
// banners that have since scrolled off / been overwritten) and match the
// retry pattern against it.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { renderTui } = await versionedImport("./tui-render.js", import.meta)

// "Retrying in <n>s · attempt <k>/<max>". The separator between the delay
// and "attempt" varies (middot, bullet, dash) across versions, so match
// loosely on anything that isn't a newline between the two anchors.
export const DISCONNECT_RE = /retrying in \d+s\b[^\n]*?attempt\s+(\d+)\s*\/\s*(\d+)/i

/**
 * Scan rendered terminal bytes for the reconnect banner.
 *
 * Pure; exported for tests. Renders the tail of `rawBytes` onto a virtual
 * screen and matches the current screen against DISCONNECT_RE.
 *
 * @param {string} rawBytes raw dtach log contents (terminal byte stream)
 * @param {{width?:number, height?:number, lines?:number}} opts
 * @returns {{attempt:number, max:number}|null}
 */
export function scanForDisconnect(rawBytes, opts = {}) {
    if (typeof rawBytes !== "string" || rawBytes.length === 0) {
        return null
    }
    const width = opts.width ?? 80
    const height = opts.height ?? 50
    const lines = opts.lines ?? 2000

    const rawLines = rawBytes.split(/\r?\n/)
    const ingest = rawLines.slice(-lines).join("\n")
    const screen = renderTui(ingest, { width, height, ansi: false, trim: true })

    const m = screen.match(DISCONNECT_RE)
    if (!m) {
        return null
    }
    return { attempt: parseInt(m[1], 10), max: parseInt(m[2], 10) }
}
