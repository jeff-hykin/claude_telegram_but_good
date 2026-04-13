import { versionedImport } from "../../../lib/version.js"

const [
    { colors },
    { restartService },
    { paths },
    { dbg },
    { ensureOnboarded, killAllServers },
] = await Promise.all([
    versionedImport("../../../imports.js", import.meta),
    versionedImport("../../../lib/daemon.js", import.meta),
    versionedImport("../../../lib/paths.js", import.meta),
    versionedImport("../../../lib/logging.js", import.meta),
    versionedImport("../helpers.js", import.meta),
])
const c = colors

export async function runRestart(_args) {
    await ensureOnboarded()
    console.log(c.dim("  Restarting cbg daemon..."))
    killAllServers({ markStopped: false })
    try { Deno.removeSync(paths.STOPPED_FILE) } catch (e) { dbg("CBG", "remove paths.STOPPED_FILE failed:", e) }
    const out = restartService()
    if (out.trim()) {
        console.log(c.dim("  " + out.trim()))
    }
    console.log(c.green("  \u2714 Done."))
}
