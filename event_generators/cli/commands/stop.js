import { versionedImport } from "../../../lib/version.js"

const [{ colors }, { killAllServers }] = await Promise.all([
    versionedImport("../../../imports.js", import.meta),
    versionedImport("../helpers.js", import.meta),
])
const c = colors

export function runStop(_args) {
    console.log(c.dim("  Stopping cbg daemon..."))
    killAllServers()
    console.log(c.green("  \u2714 Stopped. Shims will not respawn the server."))
    console.log(c.dim("  Run ") + c.white("cbg start") + c.dim(" to resume."))
}
