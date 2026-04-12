import { versionedImport } from "../../lib/version.js"

const [
    { stopService },
    { PID_FILE, STOPPED_FILE, STATE_DIR, dbg },
    { onboard, isOnboarded },
] = await Promise.all([
    versionedImport("../../lib/daemon.js", import.meta),
    versionedImport("../../lib/protocol.js", import.meta),
    versionedImport("../../lib/onboard.js", import.meta),
])

export function killAllServers({ markStopped = true } = {}) {
    Deno.mkdirSync(STATE_DIR, { recursive: true })
    if (markStopped) {
        Deno.writeTextFileSync(STOPPED_FILE, String(Date.now()))
    }
    try { stopService() } catch (e) { dbg("CBG", "stopService failed (may not be running):", e) }
    try {
        const pidStr = Deno.readTextFileSync(PID_FILE).trim()
        const pid = parseInt(pidStr)
        if (pid > 0) {
            new Deno.Command("kill", { args: [String(pid)], stdout: "null", stderr: "null" }).outputSync()
        }
    } catch (e) {
        dbg("CBG", "kill server by PID failed:", e)
    }
    try {
        new Deno.Command("pkill", {
            args: ["-f", "standalone-server\\.js"],
            stdout: "null", stderr: "null",
        }).outputSync()
    } catch (e) {
        dbg("CBG", "pkill standalone-server failed:", e)
    }
}

export async function ensureOnboarded() {
    if (!isOnboarded()) {
        console.log("Need to finish onboarding first. Running cbg onboard...\n")
        await onboard()
        if (!isOnboarded()) {
            Deno.exit(1)
        }
    }
}
