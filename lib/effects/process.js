// ---------------------------------------------------------------------------
// Process-signal effect.
//
// Handlers that need to signal a process (graceful close, force kill, …)
// emit `{ type: "signal_process", pid, signal }` and this effect calls
// Deno.kill. Keeping Deno.kill out of handlers preserves the
// "handlers are pure" contract — the effect layer is the one place
// process signaling is allowed to happen.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)

/**
 * effect shape: { type: "signal_process", pid: number, signal: string }
 */
export function signalProcess(effect, _core) {
    const { pid, signal } = effect
    if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) {
        dbg("PROC-SIG", "signal_process: invalid pid", pid)
        return
    }
    const sig = typeof signal === "string" && signal.length > 0 ? signal : "SIGTERM"
    try {
        Deno.kill(pid, sig)
        dbg("PROC-SIG", `sent ${sig} to pid ${pid}`)
    } catch (e) {
        dbg("PROC-SIG", `Deno.kill(${pid}, ${sig}) failed:`, e)
    }
}
