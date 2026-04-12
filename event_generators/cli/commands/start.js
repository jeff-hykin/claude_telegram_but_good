import { versionedImport } from "../../../lib/version.js"

const [
    { colors },
    { startService },
    { STOPPED_FILE, dbg },
    { ensureOnboarded },
] = await Promise.all([
    versionedImport("../../../imports.js", import.meta),
    versionedImport("../../../lib/daemon.js", import.meta),
    versionedImport("../../../lib/protocol.js", import.meta),
    versionedImport("../helpers.js", import.meta),
])
const c = colors

export async function runStart(_args) {
    await ensureOnboarded()
    // Clear the stopped flag so shims can spawn/reconnect
    try { Deno.removeSync(STOPPED_FILE) } catch (e) { dbg("CBG", "remove STOPPED_FILE failed:", e) }
    console.log(c.dim("  Starting cbg daemon..."))
    const out = startService()
    if (out.trim()) {
        console.log(c.dim("  " + out.trim()))
    }
    console.log(c.green("  \u2714 Done."))
}
