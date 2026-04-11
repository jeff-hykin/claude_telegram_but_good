#!/usr/bin/env -S deno run -A
/**
 * cbg — CLI for Claude Telegram Bot (claude_telegram_but_good)
 */

import { stringifyYaml, Select, Confirm, colors, join } from "./imports.js"
import { readConfig, getConfig, setConfig } from "./lib/config.js"
import { startService, stopService, restartService, serviceStatus, removeService, isDaemonRunning } from "./lib/daemon.js"
import { createSession, attachSession, listDtachSockets } from "./lib/dtach.js"
import { onboard, isOnboarded, installAndSymlinkPlugin, ensureSettingsJson, removeFromSettingsJson } from "./lib/onboard.js"
import { PID_FILE, IPC_SOCK, ACCESS_FILE, ENV_FILE, STOPPED_FILE, STATE_DIR, LOCAL_REPO, dbg } from "./lib/protocol.js"
import { CONFIG_DIR, CONFIG_FILE } from "./lib/protocol.js"
import { installShim, removeShim, isShimInstalled } from "./lib/shim.js"

const c = colors
const [cmd, ...args] = Deno.args

function killAllServers({ markStopped = true } = {}) {
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
    } catch { /* not running */ }
    try {
        new Deno.Command("pkill", {
            args: ["-f", "standalone-server\\.js"],
            stdout: "null", stderr: "null",
        }).outputSync()
    } catch { /* none found */ }
}

async function ensureOnboarded() {
    if (!isOnboarded()) {
        console.log("Need to finish onboarding first. Running cbg onboard...\n")
        await onboard()
        if (!isOnboarded()) {
            Deno.exit(1)
        }
    }
}

function printUsage() {
    console.log()
    console.log(c.bold.cyan("  cbg") + c.dim(" — Claude Telegram But Good"))
    console.log()
    console.log(c.bold.white("  Commands:"))
    console.log()

    const cmds = [
        ["onboard",          "Full setup: dtach, bot token, plugin, pairing, shim"],
        ["start",            "Start the daemon (creates systemd/launchd service)"],
        ["stop",             "Stop the daemon"],
        ["restart",          "Stop + start"],
        ["new [opts] [...]", "New dtach session (" + c.dim("--title T") + ", rest passed to claude)"],
        ["resume [id]",      "Attach to a dtach session (interactive picker if no id)"],
        ["status",           "Show daemon status + active sessions"],
        ["config",           "Print all config as YAML"],
        ["config <key>",     "Print a single config value"],
        ["config <key> <v>", "Set a config value (value is YAML-parsed)"],
        ["authorize",        "Generate a one-time pairing code for a new user"],
        ["reinstall",        "Stop, re-symlink plugin + reshim, start"],
        ["uninstall",        "Stop services and remove the claude shim"],
    ]

    for (const [name, desc] of cmds) {
        console.log(`    ${c.cyan(name.padEnd(20))}${c.dim(desc)}`)
    }

    console.log()
    console.log(c.dim("  The claude shim (installed by onboard) wraps every `claude`"))
    console.log(c.dim("  invocation with Telegram channels + dtach automatically."))
    console.log(c.dim("  Use ") + c.white("claude --no-tele") + c.dim(" to bypass."))
    console.log()
}

switch (cmd) {
    case "onboard": {
        await onboard()
        break
    }

    case "start": {
        await ensureOnboarded()
        // Clear the stopped flag so shims can spawn/reconnect
        try { Deno.removeSync(STOPPED_FILE) } catch { /* ignore */ }
        console.log(c.dim("  Starting cbg daemon..."))
        const out = startService()
        if (out.trim()) {
            console.log(c.dim("  " + out.trim()))
        }
        console.log(c.green("  \u2714 Done."))
        break
    }

    case "stop": {
        console.log(c.dim("  Stopping cbg daemon..."))
        killAllServers()
        console.log(c.green("  \u2714 Stopped. Shims will not respawn the server."))
        console.log(c.dim("  Run ") + c.white("cbg start") + c.dim(" to resume."))
        break
    }

    case "restart": {
        // Restart is dangerous: it cuts the IPC connection of every live shim
        // and (until KillMode=process is rolled out) kills /new'd sessions
        // outright. Claude sessions kept blindly running it during debug
        // sessions and taking out their siblings, so we now require an
        // explicit confirmation token. The phrase is annoying on purpose so
        // an LLM won't paste it without thinking.
        const CONFIRM_TOKEN = "yes-disconnect-everyone"
        if (!args.includes(CONFIRM_TOKEN)) {
            console.log()
            console.log(c.bold.yellow("  ⚠ cbg restart will:"))
            console.log(c.dim("    • drop the IPC connection of every live Telegram shim"))
            console.log(c.dim("    • on older systemd units (KillMode=control-group), also"))
            console.log(c.dim("      terminate every claude session that was spawned via"))
            console.log(c.dim("      Telegram /new"))
            console.log()
            console.log(c.dim("  If you're sure, run:"))
            console.log("    " + c.white(`cbg restart ${CONFIRM_TOKEN}`))
            console.log()
            console.log(c.dim("  In most cases you actually want one of:"))
            console.log("    " + c.white("cbg status") + c.dim("           — check what's running"))
            console.log("    " + c.white("/reload") + c.dim(" (in Telegram) — hot-reload commands without dropping sessions"))
            Deno.exit(1)
        }
        await ensureOnboarded()
        console.log(c.dim("  Restarting cbg daemon..."))
        killAllServers({ markStopped: false })
        try { Deno.removeSync(STOPPED_FILE) } catch (e) { dbg("CBG", "remove STOPPED_FILE failed:", e) }
        const out = restartService()
        if (out.trim()) {
            console.log(c.dim("  " + out.trim()))
        }
        console.log(c.green("  \u2714 Done."))
        break
    }

    case "new": {
        await ensureOnboarded()
        let title
        const claudeArgs = []
        for (let i = 0; i < args.length; i++) {
            if (args[i] === "--title" && i + 1 < args.length) {
                title = args[i + 1]
                i++
            } else {
                claudeArgs.push(args[i])
            }
        }
        createSession(title, claudeArgs)
        break
    }

    case "resume": {
        if (args[0]) {
            attachSession(args[0])
        } else {
            const sockets = listDtachSockets()
            if (sockets.length === 0) {
                console.log(c.yellow("  No active dtach sessions."))
                console.log(c.dim("  Create one with: ") + c.cyan("cbg new"))
                break
            }

            try {
                const selected = await Select.prompt({
                    message: "Select a session to resume:",
                    options: sockets.map(s => ({
                        name: `Session ${s.id}`,
                        value: s.id,
                    })),
                })
                attachSession(selected)
            } catch {
                console.log(c.bold.white("  Active dtach sessions:"))
                for (const s of sockets) {
                    console.log(`    ${c.cyan(s.id)}  ${c.dim(s.socketPath)}`)
                }
                console.log(c.dim("\n  Usage: ") + c.white("cbg resume <session-id>"))
            }
        }
        break
    }

    case "status": {
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
        } catch {
            console.log(c.dim("  \u2500 Daemon: not running"))
        }

        try {
            Deno.statSync(IPC_SOCK)
            console.log(c.green("  \u2714 IPC socket: ") + c.dim(IPC_SOCK))
        } catch {
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
        break
    }

    case "config": {
        if (args.length === 0) {
            const config = readConfig()
            if (Object.keys(config).length === 0) {
                console.log(c.dim("  # No config set yet. Use: ") + c.white("cbg config <key> <value>"))
            } else {
                console.log(stringifyYaml(config).trimEnd())
            }
        } else if (args.length === 1) {
            const val = getConfig(args[0])
            if (val === undefined) {
                console.log(c.dim("(not set)"))
            } else {
                console.log(typeof val === "object" ? JSON.stringify(val) : String(val))
            }
        } else {
            setConfig(args[0], args.slice(1).join(" "))
            console.log(c.green("  \u2714 Set ") + c.white(args[0]))
        }
        break
    }

    case "authorize": {
        const otp = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, "0")).join("")
        const otpFile = join(STATE_DIR, "pending_otp.json")
        Deno.mkdirSync(STATE_DIR, { recursive: true })
        Deno.writeTextFileSync(otpFile, JSON.stringify({ code: otp }))
        console.log()
        console.log(c.bold.white("  Pairing code generated."))
        console.log()
        console.log(c.dim("  Have the new user send this to your bot on Telegram:"))
        console.log()
        console.log(c.bold.cyan(`    /approve_user one_time_password:${otp}`))
        console.log()
        break
    }

    case "reinstall": {
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
                break
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
        try { Deno.removeSync(STOPPED_FILE) } catch { /* ignore */ }
        console.log(c.dim("  Starting daemon..."))
        const out = startService()
        if (out.trim()) {
            console.log(c.dim("  " + out.trim()))
        }
        console.log(c.green("  \u2714 Done."))
        console.log()
        break
    }

    case "uninstall": {
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
            const pidStr = Deno.readTextFileSync(PID_FILE).trim()
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
            message: c.white("  Remove bot token?") + c.dim(` (${CONFIG_FILE} + legacy .env)`),
            default: false,
        })
        if (removeToken) {
            try { Deno.removeSync(CONFIG_DIR, { recursive: true }) } catch (e) { dbg("UNINSTALL", "remove config:", e) }
            try { Deno.removeSync(ENV_FILE) } catch (e) { dbg("UNINSTALL", "remove env:", e) }
            console.log(c.green("  \u2714 ") + "Bot token and config dir removed.")
        }

        // Offer to remove paired chat IDs
        const removeAccess = await Confirm.prompt({
            message: c.white("  Remove paired chat IDs?") + c.dim(" (access.json allowlist)"),
            default: false,
        })
        if (removeAccess) {
            try { Deno.removeSync(ACCESS_FILE) } catch (e) { dbg("UNINSTALL", "remove access:", e) }
            console.log(c.green("  \u2714 ") + "Access file removed.")
        }

        // Remove state dir (sockets, logs, pid files)
        console.log(c.dim("  Removing state directory..."))
        try { Deno.removeSync(STATE_DIR, { recursive: true }) } catch (e) { dbg("UNINSTALL", "remove state dir:", e) }
        console.log(c.green("  \u2714 ") + "State directory removed.")

        // Remove installed repo (unless it's a symlink to a dev repo)
        try {
            const stat = Deno.lstatSync(LOCAL_REPO)
            if (stat.isSymlink) {
                Deno.removeSync(LOCAL_REPO)
                console.log(c.green("  \u2714 ") + "Dev symlink removed (source repo untouched).")
            } else {
                Deno.removeSync(LOCAL_REPO, { recursive: true })
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
        break
    }

    case undefined:
    case "help":
    case "--help":
    case "-h": {
        printUsage()
        break
    }

    default: {
        console.error(c.red(`  Unknown command: ${cmd}`))
        printUsage()
        Deno.exit(1)
    }
}
