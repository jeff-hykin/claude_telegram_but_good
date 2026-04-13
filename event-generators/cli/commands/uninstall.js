import { versionedImport } from "../../../lib/version.js"

const [
    { Confirm, colors },
    { removeService },
    { paths },
    { dbg },
    { removeShim },
    { removeFromSettingsJson },
] = await Promise.all([
    versionedImport("../../../imports.js", import.meta),
    versionedImport("../../../lib/daemon.js", import.meta),
    versionedImport("../../../lib/paths.js", import.meta),
    versionedImport("../../../lib/logging.js", import.meta),
    versionedImport("../shim-setup.js", import.meta),
    versionedImport("../helpers.js", import.meta),
])
const c = colors

export async function runUninstall(_args) {
    console.log()
    console.log(c.bold.white("  Uninstalling cbg..."))
    console.log(c.dim("  " + "\u2500".repeat(40)))

    // Stop and remove the service (launchd/systemd)
    console.log(c.dim("  Stopping and removing service..."))
    try {
        removeService()
        console.log(c.green("  \u2714 ") + "Service removed.")
    } catch (e) {
        console.log(c.yellow("  \u26A0 ") + "Service removal: " + e)
    }

    // Kill server by PID (in case it was running outside the service)
    try {
        const pidStr = Deno.readTextFileSync(paths.PID_FILE).trim()
        const pid = parseInt(pidStr)
        if (pid > 0) {
            new Deno.Command("kill", { args: [String(pid)], stdout: "null", stderr: "null" }).outputSync()
            console.log(c.green("  \u2714 ") + `Killed server ${c.dim(`(PID ${pid})`)}`)
        }
    } catch (e) {
        dbg("UNINSTALL", "kill server by PID:", e)
    }

    // Remove hooks and plugin from settings.json
    console.log(c.dim("  Removing hooks from settings.json..."))
    try {
        removeFromSettingsJson()
        console.log(c.green("  \u2714 ") + "Hooks and plugin removed from settings.json.")
    } catch (e) {
        console.log(c.yellow("  \u26A0 ") + "settings.json cleanup: " + e)
    }

    // Remove the claude shim
    console.log(c.dim("  Removing claude shim..."))
    const shimResult = removeShim()
    if (shimResult.ok) {
        console.log(c.green("  \u2714 ") + shimResult.message)
    } else {
        console.log(c.yellow("  \u26A0 ") + shimResult.message)
    }

    // Offer to remove bot token
    console.log()
    const removeToken = await Confirm.prompt({
        message: c.white("  Remove bot token?") + c.dim(` (${paths.CONFIG_FILE} + legacy .env)`),
        default: false,
    })
    if (removeToken) {
        try { Deno.removeSync(paths.CONFIG_FILE) } catch (e) { dbg("UNINSTALL", "remove config file:", e) }
        try { Deno.removeSync(paths.ENV_FILE) } catch (e) { dbg("UNINSTALL", "remove env:", e) }
        console.log(c.green("  \u2714 ") + "Bot token removed.")
    }

    // Offer to remove paired chat IDs
    const removeAccess = await Confirm.prompt({
        message: c.white("  Remove paired chat IDs?") + c.dim(" (access.json allowlist)"),
        default: false,
    })
    if (removeAccess) {
        try { Deno.removeSync(paths.ACCESS_FILE) } catch (e) { dbg("UNINSTALL", "remove access:", e) }
        console.log(c.green("  \u2714 ") + "Access file removed.")
    }

    // Remove state dir (sockets, logs, pid files)
    console.log(c.dim("  Removing state directory..."))
    try { Deno.removeSync(paths.STATE_DIR, { recursive: true }) } catch (e) { dbg("UNINSTALL", "remove state dir:", e) }
    console.log(c.green("  \u2714 ") + "State directory removed.")

    // Remove installed repo (unless it's a symlink to a dev repo)
    try {
        const stat = Deno.lstatSync(paths.LOCAL_REPO)
        if (stat.isSymlink) {
            Deno.removeSync(paths.LOCAL_REPO)
            console.log(c.green("  \u2714 ") + "Dev symlink removed (source repo untouched).")
        } else {
            Deno.removeSync(paths.LOCAL_REPO, { recursive: true })
            console.log(c.green("  \u2714 ") + "Installed repo removed.")
        }
    } catch (e) {
        dbg("UNINSTALL", "remove local repo:", e)
    }

    // Remove the cbg binary itself
    console.log(c.dim("  Removing cbg CLI..."))
    new Deno.Command("deno", {
        args: ["uninstall", "-g", "cbg"],
        stdout: "null",
        stderr: "null",
    }).outputSync()
    console.log(c.green("  \u2714 ") + "cbg uninstalled.")

    console.log()
    console.log(c.green("  \u2714 All done. cbg has been fully removed."))
    console.log()
}
