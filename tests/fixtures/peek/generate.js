// Regenerate golden fixture outputs for the peek TUI renderer.
//
// Reads `input.log` (a raw dtach log capture) and writes four
// rendered variants into this directory:
//
//   trimmed.txt          — sanitized plain text, with trailing-marker trim
//   trimmed.ansi         — ANSI-colored, with trailing-marker trim
//   untrimmed.txt        — sanitized plain text, no trim
//   untrimmed.ansi       — ANSI-colored, no trim
//
// The outputs are committed so diffs highlight renderer regressions
// over time. To update them, run:
//
//   deno run --allow-read --allow-write tests/fixtures/peek/generate.js [w] [h] [lines]
//
// Defaults: width=80, height=50, historyLines=3000.

import { renderTui, trimTrailingMarker } from "../../../lib/pure/tui-render.js"

const w = parseInt(Deno.args[0] ?? "80", 10)
const h = parseInt(Deno.args[1] ?? "50", 10)
const historyLines = parseInt(Deno.args[2] ?? "3000", 10)

const hereUrl = new URL("./", import.meta.url)
const raw = await Deno.readTextFile(new URL("input.log", hereUrl))
const ingest = raw.split(/\r?\n/).slice(-historyLines).join("\n")

const plainFull = renderTui(ingest, { width: w, height: h, ansi: false, trim: true })
const ansiFull = renderTui(ingest, { width: w, height: h, ansi: true, trim: true })
const plainTrimmed = trimTrailingMarker(plainFull)
const ansiTrimmed = trimTrailingMarker(ansiFull)

// Scrub any residual control bytes from the plain outputs so the
// .txt files are 100% printable UTF-8 with no ESC sequences.
const sanitize = (s) => s
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\x1b/g, "")

const header = `=== rendered ${w}x${h}, lines=${historyLines} ===\n`
const footer = (body) => `\n=== end (${body.length} chars) ===\n`

const writes = [
    ["trimmed.txt", header + sanitize(plainTrimmed) + footer(sanitize(plainTrimmed))],
    ["trimmed.ansi", header + ansiTrimmed + "\x1b[0m" + footer(ansiTrimmed)],
    ["untrimmed.txt", header + sanitize(plainFull) + footer(sanitize(plainFull))],
    ["untrimmed.ansi", header + ansiFull + "\x1b[0m" + footer(ansiFull)],
]

for (const [name, body] of writes) {
    await Deno.writeTextFile(new URL(name, hereUrl), body)
    console.log(`wrote ${name} (${body.length} chars)`)
}
