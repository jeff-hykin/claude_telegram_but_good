// ---------------------------------------------------------------------------
// lib/logging.js — `dbg` logger.
//
// Every reloadable module in CBG uses `dbg("LABEL", ...)` for debug output.
// This was the single most-used export of the old lib/protocol.js grab-bag;
// it lives here on its own now.
//
// Output: stderr (always) + append to paths.LOG_FILE (best-effort). If the
// log-file write fails we warn to stderr and continue — logging must never
// block or throw.
//
// paths is loaded via `versionedImport` so this module shares the single
// versioned `paths` singleton with the rest of the reloadable graph.
// A bare `import { paths } from "./paths.js"` would resolve to a DIFFERENT
// URL than `versionedImport`'s `?v=<cbgVersion>` variant and produce a
// second, independent `paths` object — which breaks any test (or future
// runtime code) that mutates the singleton through `buildPaths`.
// ---------------------------------------------------------------------------

import { versionedImport } from "./version.js"

const { paths } = await versionedImport("./paths.js", import.meta)

const encoder = new TextEncoder()
const DEBUG = true

export function dbg(label, ...args) {
    if (!DEBUG) {
        return
    }
    const ts = new Date().toISOString()
    const line = `[TG-DBG ${ts}] ${label}: ${args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ")}\n`
    Deno.stderr.writeSync(encoder.encode(line))
    try {
        Deno.writeTextFileSync(paths.LOG_FILE, line, { append: true })
    } catch (e) {
        Deno.stderr.writeSync(encoder.encode(`[TG-DBG ${ts}] LOG: write to ${paths.LOG_FILE} failed: ${e}\n`))
    }
}
