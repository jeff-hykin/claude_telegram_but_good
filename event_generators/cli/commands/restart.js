import { versionedImport } from "../../../lib/version.js"

const [
    { colors },
    { restartService },
    { STOPPED_FILE, dbg },
    { ensureOnboarded, killAllServers },
] = await Promise.all([
    versionedImport("../../../imports.js", import.meta),
    versionedImport("../../../lib/daemon.js", import.meta),
    versionedImport("../../../lib/protocol.js", import.meta),
    versionedImport("../helpers.js", import.meta),
])
const c = colors

export async function runRestart(_args) {
    await ensureOnboarded()
    console.log(c.dim("  Restarting cbg daemon..."))
    killAllServers({ markStopped: false })
    try { Deno.removeSync(STOPPED_FILE) } catch (e) { dbg("CBG", "remove STOPPED_FILE failed:", e) }
    const out = restartService()
    if (out.trim()) {
        console.log(c.dim("  " + out.trim()))
    }
    console.log(c.green("  \u2714 Done."))
}
