import { versionedImport } from "../../../lib/version.js"

const [
    { colors },
    { serviceStatus },
    { listDtachSockets },
    { PID_FILE, IPC_SOCK, dbg },
] = await Promise.all([
    versionedImport("../../../imports.js", import.meta),
    versionedImport("../../../lib/daemon.js", import.meta),
    versionedImport("../../../lib/dtach.js", import.meta),
    versionedImport("../../../lib/protocol.js", import.meta),
])
const c = colors

export function runStatus(_args) {
    console.log()
    console.log(c.bold.white("  CBG Status"))
    console.log(c.dim("  " + "\u2500".repeat(40)))

    let daemonRunning = false
    try {
        const pidStr = Deno.readTextFileSync(PID_FILE).trim()
        const pid = parseInt(pidStr)
        const result = new Deno.Command("kill", {
            args: ["-0", String(pid)],
            stdout: "null",
            stderr: "null",
        }).outputSync()
        daemonRunning = result.success
        if (daemonRunning) {
            console.log(c.green("  \u2714 Daemon: ") + `running ${c.dim(`(PID ${pid})`)}`)
        } else {
            console.log(c.yellow("  \u26A0 Daemon: ") + c.dim("not running (stale PID file)"))
        }
    } catch (e) {
        dbg("CBG", "status: PID file read/kill -0 failed:", e)
        console.log(c.dim("  \u2500 Daemon: not running"))
    }

    try {
        Deno.statSync(IPC_SOCK)
        console.log(c.green("  \u2714 IPC socket: ") + c.dim(IPC_SOCK))
    } catch (e) {
        dbg("CBG", "status: IPC socket stat failed:", e)
        console.log(c.dim("  \u2500 IPC socket: not found"))
    }

    const sockets = listDtachSockets()
    console.log()
    console.log(c.bold.white(`  Dtach sessions: ${sockets.length}`))
    if (sockets.length > 0) {
        for (const s of sockets) {
            console.log(`    ${c.cyan(s.id)}  ${c.dim(s.socketPath)}`)
        }
    }

    console.log()
    console.log(c.bold.white("  Service:"))
    const svcStatus = serviceStatus()
    const svcText = svcStatus.trim()
    if (!svcText || svcText.includes("Could not find service")) {
        if (daemonRunning) {
            console.log(c.yellow("  \u26A0 Daemon running but not via service manager. Run `cbg reinstall` to fix."))
        } else {
            console.log(c.dim("    not installed. Run `cbg onboard` or `cbg start`."))
        }
    } else {
        for (const line of svcText.split("\n")) {
            console.log(c.dim("    " + line))
        }
    }
    console.log()
}
