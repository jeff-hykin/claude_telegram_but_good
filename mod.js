#!/usr/bin/env -S deno run -A
/**
 * cbg — CLI for Claude Telegram Bot (claude_telegram_but_good)
 */

import { stringifyYaml, Select, Confirm, colors, join, sibling } from "./imports.js"
import { readConfig, getConfig, setConfig } from "./lib/config.js"
import { startService, stopService, restartService, serviceStatus } from "./lib/daemon.js"
import { createSession, attachSession, listDtachSockets } from "./lib/dtach.js"
import { onboard, isOnboarded } from "./lib/onboard.js"
import { PID_FILE, IPC_SOCK, ACCESS_FILE, ENV_FILE, STOPPED_FILE, STATE_DIR } from "./lib/protocol.js"
import { configPath, configDir } from "./lib/config.js"
import { installShim, removeShim, isShimInstalled } from "./lib/shim.js"

const c = colors
const [cmd, ...args] = Deno.args

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

        // Signal shims to not respawn the server
        Deno.mkdirSync(STATE_DIR, { recursive: true })
        Deno.writeTextFileSync(STOPPED_FILE, String(Date.now()))

        // Stop the systemd/launchd service
        const out = stopService()
        if (out.trim()) {
            console.log(c.dim("  " + out.trim()))
        }

        // Kill the server by PID
        try {
            const pidStr = Deno.readTextFileSync(PID_FILE).trim()
            const pid = parseInt(pidStr)
            if (pid > 0) {
                new Deno.Command("kill", { args: [String(pid)], stdout: "null", stderr: "null" }).outputSync()
            }
        } catch {
            // not running
        }

        console.log(c.green("  \u2714 Stopped. Shims will not respawn the server."))
        console.log(c.dim("  Run ") + c.white("cbg start") + c.dim(" to resume."))
        break
    }

    case "restart": {
        await ensureOnboarded()
        try { Deno.removeSync(STOPPED_FILE) } catch { /* ignore */ }
        console.log(c.dim("  Restarting cbg daemon..."))
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
        if (svcStatus.trim()) {
            for (const line of svcStatus.trim().split("\n")) {
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

    case "reinstall": {
        const HOME = Deno.env.get("HOME")
        console.log()
        console.log(c.bold.white("  Reinstalling cbg..."))
        console.log(c.dim("  " + "\u2500".repeat(40)))

        // Stop daemon
        console.log(c.dim("  Stopping daemon..."))
        Deno.mkdirSync(STATE_DIR, { recursive: true })
        Deno.writeTextFileSync(STOPPED_FILE, String(Date.now()))
        try {
            stopService()
        } catch { /* may not be running */ }
        try {
            const pidStr = Deno.readTextFileSync(PID_FILE).trim()
            const pid = parseInt(pidStr)
            if (pid > 0) {
                new Deno.Command("kill", { args: [String(pid)], stdout: "null", stderr: "null" }).outputSync()
            }
        } catch { /* not running */ }
        console.log(c.green("  \u2714 Daemon stopped."))

        // Re-symlink plugin
        console.log(c.dim("  Re-symlinking plugin..."))
        const pluginDir = join(
            HOME, ".claude", "plugins", "marketplaces",
            "claude-plugins-official", "external_plugins", "telegram",
        )
        const pluginSrcDir = sibling(import.meta, ".")
        try {
            try { Deno.removeSync(pluginDir, { recursive: true }) } catch { /* ignore */ }
            Deno.mkdirSync(join(pluginDir, ".."), { recursive: true })
            Deno.symlinkSync(pluginSrcDir, pluginDir)
            console.log(c.green("  \u2714 Plugin symlinked."))
        } catch (err) {
            console.log(c.yellow("  \u26A0 Plugin symlink failed: " + err))
        }

        // Update hook script
        console.log(c.dim("  Updating hook script..."))
        const hookDst = join(HOME, ".claude", "channels", "telegram", "bin", "hook")
        const hookSrc = sibling(import.meta, "run/hook")
        try {
            Deno.mkdirSync(join(hookDst, ".."), { recursive: true })
            Deno.writeTextFileSync(hookDst, Deno.readTextFileSync(hookSrc))
            Deno.chmodSync(hookDst, 0o755)
            console.log(c.green("  \u2714 Hook updated."))
        } catch (err) {
            console.log(c.yellow("  \u26A0 Hook update failed: " + err))
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

        // Stop the daemon
        console.log(c.dim("  Stopping daemon..."))
        try {
            const out = stopService()
            if (out.trim()) {
                console.log(c.dim("    " + out.trim()))
            }
        } catch {
            // may not be running
        }

        // Kill server by PID
        try {
            const pidStr = Deno.readTextFileSync(PID_FILE).trim()
            const pid = parseInt(pidStr)
            if (pid > 0) {
                new Deno.Command("kill", { args: [String(pid)], stdout: "null", stderr: "null" }).outputSync()
                console.log(c.green("  \u2714 ") + `Killed server ${c.dim(`(PID ${pid})`)}`)
            }
        } catch {
            // not running or no pid file
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
            message: c.white("  Remove bot token?") + c.dim(" (~/.config/cbg/config.yaml + legacy .env)"),
            default: false,
        })
        if (removeToken) {
            try { Deno.removeSync(configDir(), { recursive: true }) } catch { /* ignore */ }
            try { Deno.removeSync(ENV_FILE) } catch { /* ignore */ }
            console.log(c.green("  \u2714 ") + "Bot token and config dir removed.")
        }

        // Offer to remove paired chat IDs
        const removeAccess = await Confirm.prompt({
            message: c.white("  Remove paired chat IDs?") + c.dim(" (access.json allowlist)"),
            default: false,
        })
        if (removeAccess) {
            try { Deno.removeSync(ACCESS_FILE) } catch { /* ignore */ }
            console.log(c.green("  \u2714 ") + "Access file removed.")
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
