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
const { paths } = await versionedImport("../paths.js", import.meta)

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

/**
 * effect shape: { type: "kill_dtach_session", sessionId: string }
 *
 * SIGTERMs the dtach master for a session that never registered, so there is
 * no pid in state to signal. The master takes its pty children down with it
 * and removes the socket.
 */
export async function killDtachSession(effect, _core) {
    const sock = paths.dtachSockFile(effect.sessionId)
    const pattern = `dtach -n ${sock.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `
    const { stdout } = await new Deno.Command("pgrep", { args: ["-f", pattern], stdout: "piped", stderr: "null" }).output()
    const pids = new TextDecoder().decode(stdout).split(/\s+/).filter(Boolean).map(Number)
    if (pids.length === 0) {
        dbg("PROC-SIG", `kill_dtach_session: no dtach master for ${effect.sessionId}`)
    }
    for (const pid of pids) {
        signalProcess({ pid, signal: "SIGTERM" })
    }
}
