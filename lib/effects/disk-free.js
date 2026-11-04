// ---------------------------------------------------------------------------
// lib/effects/disk-free.js
//
// `measure_disk_free` — the IO half of lib/event-handlers/disk-guard-check.js.
// Runs `df -k <path>` and hands the result back as a `disk_guard_check` event
// carrying `freeGb`. Fire-and-forget; a measurement in flight skips the next.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)

let measureInFlight = false

async function freeGbOn(path) {
    const output = await new Deno.Command("df", { args: ["-k", path], stdout: "piped", stderr: "piped" }).output()
    if (!output.success) {
        throw new Error(`df exited ${output.code}: ${new TextDecoder().decode(output.stderr).trim()}`)
    }
    const availableKb = Number(new TextDecoder().decode(output.stdout).trim().split("\n").pop().split(/\s+/)[3])
    if (!Number.isFinite(availableKb)) {
        throw new Error("could not parse df output")
    }
    return availableKb / 1024 / 1024
}

/** effect shape: { type: "measure_disk_free", path } */
export function measureDiskFree(effect, core) {
    if (measureInFlight) {
        dbg("DISK-GUARD", "previous df still running — skipping this one")
        return
    }
    measureInFlight = true
    freeGbOn(effect.path)
        .then((freeGb) => {
            core.enqueueEvent?.({ type: "disk_guard_check", freeGb, path: effect.path })
        })
        .catch((e) => {
            dbg("DISK-GUARD", `df ${effect.path} failed:`, e)
        })
        .finally(() => {
            measureInFlight = false
        })
}
