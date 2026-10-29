// ---------------------------------------------------------------------------
// lib/effects/long-run-scan.js
//
// `scan_long_runs` — the IO half of lib/event-handlers/long-run-check.js.
// Snapshots the process table with one `ps` and hands it back as a
// `long_run_check` event carrying `processes`. Fire-and-forget so the event
// loop never waits on `ps`; a scan still in flight makes the next one a no-op.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { parsePsTable } = await versionedImport("../pure/long-runs.js", import.meta)

let scanInFlight = false

async function readProcessTable() {
    // -ww: never truncate args, they carry the command text
    const output = await new Deno.Command("ps", {
        args: ["-axww", "-o", "pid=,ppid=,etime=,args="],
        stdout: "piped",
        stderr: "piped",
    }).output()
    if (!output.success) {
        throw new Error(`ps exited ${output.code}: ${new TextDecoder().decode(output.stderr).trim()}`)
    }
    return parsePsTable(new TextDecoder().decode(output.stdout))
}

/** effect shape: { type: "scan_long_runs" } */
export function scanLongRuns(_effect, core) {
    if (scanInFlight) {
        dbg("LONG-RUN", "previous ps scan still running — skipping this one")
        return
    }
    scanInFlight = true
    readProcessTable()
        .then((processes) => {
            core.enqueueEvent?.({ type: "long_run_check", ts: Date.now(), processes })
        })
        .catch((e) => {
            dbg("LONG-RUN", "process scan failed:", e)
        })
        .finally(() => {
            scanInFlight = false
        })
}
