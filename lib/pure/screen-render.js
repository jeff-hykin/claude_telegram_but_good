// ---------------------------------------------------------------------------
// lib/pure/screen-render.js — replay raw terminal bytes onto a virtual screen.
//
// Extracted from commands/peek.js so the Claude agent backend's
// readScreen() and the /peek command share one implementation. Pure:
// takes text in, returns text out, touches no filesystem.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { renderTui, trimTrailingMarker } = await versionedImport("./tui-render.js", import.meta)

/**
 * Render the tail of a raw dtach log through the VT100 emulator, growing
 * the history window until the rendered screen has at least `height`
 * non-blank rows or the whole log has been consumed.
 *
 * A short window is the common case and cheap; the growth loop exists
 * because a recent clear-screen can leave the tail nearly empty, which
 * would otherwise render as a blank screen.
 *
 * @param {string} raw — full raw log contents
 * @returns {{rendered: string, historyUsed: number, totalLines: number}}
 */
export function renderScreenFromLog(raw, { width = 80, height = 50, historyStart = 3000 } = {}) {
    const rawLines = raw.split("\n")
    const totalLines = rawLines.length
    let historyLines = historyStart
    while (true) {
        const taken = Math.min(historyLines, totalLines)
        const ingest = rawLines.slice(-taken).join("\n")
        let rendered = renderTui(ingest, { width, height, ansi: false, trim: true })
        rendered = trimTrailingMarker(rendered)
        const nonBlank = rendered.split("\n").filter((line) => line.trim().length > 0).length
        if (nonBlank >= height || taken >= totalLines) {
            return { rendered, historyUsed: taken, totalLines }
        }
        historyLines *= 2
    }
}
