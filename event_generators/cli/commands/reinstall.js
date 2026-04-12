import { versionedImport } from "../../../lib/version.js"

const [
    { Confirm, colors },
    { startService, isDaemonRunning },
    { installAndSymlinkPlugin, ensureSettingsJson },
    { STOPPED_FILE, dbg },
    { installShim },
    { killAllServers },
] = await Promise.all([
    versionedImport("../../../imports.js", import.meta),
    versionedImport("../../../lib/daemon.js", import.meta),
    versionedImport("../../../lib/onboard.js", import.meta),
    versionedImport("../../../lib/protocol.js", import.meta),
    versionedImport("../../../lib/shim.js", import.meta),
    versionedImport("../helpers.js", import.meta),
])
const c = colors

export async function runReinstall(_args) {
    console.log()
    console.log(c.bold.white("  Reinstalling cbg..."))
    console.log(c.dim("  " + "\u2500".repeat(40)))

    if (isDaemonRunning()) {
        console.log()
        console.log(c.yellow("  \u26A0 The cbg daemon is currently running."))
        console.log(c.yellow("    Reinstalling will stop it and break all existing shim connections"))
        console.log(c.yellow("    (every Claude session attached to this daemon will lose its Telegram link"))
        console.log(c.yellow("    until that session is restarted)."))
        console.log()
        const proceed = await Confirm.prompt({
            message: c.dim("  Continue with reinstall?"),
            default: false,
        })
        if (!proceed) {
            console.log(c.dim("  Aborted."))
            console.log()
            return
        }
    }

    // Stop daemon
    console.log(c.dim("  Stopping daemon..."))
    killAllServers()
    console.log(c.green("  \u2714 Daemon stopped."))

    // Reinstall plugin via Claude CLI, then symlink over the result
    console.log(c.dim("  Reinstalling plugin..."))
    const pluginResult = installAndSymlinkPlugin()
    if (pluginResult.ok) {
        console.log(c.green("  \u2714 Plugin symlinked."))
    } else {
        console.log(c.yellow("  \u26A0 " + pluginResult.error))
    }

    // Update settings.json (plugin + hooks)
    console.log(c.dim("  Updating settings.json..."))
    try {
        ensureSettingsJson()
        console.log(c.green("  \u2714 Settings updated."))
    } catch (err) {
        console.log(c.yellow("  \u26A0 Settings update failed: " + err))
    }

    // Reinstall shim
    console.log(c.dim("  Reinstalling claude shim..."))
    const shimResult = installShim()
    if (shimResult.ok) {
        console.log(c.green("  \u2714 ") + shimResult.message)
    } else {
        console.log(c.yellow("  \u26A0 ") + shimResult.message)
    }

    // Start daemon
    try { Deno.removeSync(STOPPED_FILE) } catch (e) { dbg("CBG", "remove STOPPED_FILE failed:", e) }
    console.log(c.dim("  Starting daemon..."))
    const out = startService()
    if (out.trim()) {
        console.log(c.dim("  " + out.trim()))
    }
    console.log(c.green("  \u2714 Done."))
    console.log()
}
