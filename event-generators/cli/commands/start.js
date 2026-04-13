import { versionedImport } from "../../../lib/version.js"

const [
    { colors },
    { startService },
    { paths },
    { dbg },
    { ensureOnboarded },
] = await Promise.all([
    versionedImport("../../../imports.js", import.meta),
    versionedImport("../../../lib/daemon.js", import.meta),
    versionedImport("../../../lib/paths.js", import.meta),
    versionedImport("../../../lib/logging.js", import.meta),
    versionedImport("../helpers.js", import.meta),
])
const c = colors

export async function runStart(_args) {
    await ensureOnboarded()
    // Clear the stopped flag so shims can spawn/reconnect
    try { Deno.removeSync(paths.STOPPED_FILE) } catch (e) { dbg("CBG", "remove paths.STOPPED_FILE failed:", e) }
    console.log(c.dim("  Starting cbg daemon..."))
    const out = startService()
    if (out.trim()) {
        console.log(c.dim("  " + out.trim()))
    }
    console.log(c.green("  \u2714 Done."))
}
