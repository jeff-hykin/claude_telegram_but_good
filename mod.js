#!/usr/bin/env -S deno run -A
/**
 * cbg — CLI for Claude Telegram Bot (claude_telegram_but_good)
 *
 * Usage:
 *   cbg onboard          Full setup: install dtach, register Claude plugin, prompt for bot token
 *   cbg start            Start the daemon (systemd/launchd)
 *   cbg stop             Stop the daemon
 *   cbg restart          Restart the daemon
 *   cbg new [--title T] [claude args...]  Create a new dtach session with telegram
 *   cbg resume [id]      Attach to a dtach session (interactive selector if no id)
 *   cbg status           Show daemon status + list sessions
 *   cbg config           Print all config as YAML
 *   cbg config <key>     Print a single config value
 *   cbg config <key> <v> Set a config value (value is YAML-parsed)
 */

import { stringifyYaml, Select } from "./imports.js"
import { readConfig, getConfig, setConfig } from "./lib/config.js"
import { startService, stopService, restartService, serviceStatus } from "./lib/daemon.js"
import { createSession, attachSession, listDtachSockets } from "./lib/dtach.js"
import { onboard, isOnboarded } from "./lib/onboard.js"
import { PID_FILE, IPC_SOCK } from "./lib/protocol.js"
import { removeShim } from "./lib/shim.js"

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
    console.log(`cbg — Claude Telegram Bot CLI

Commands:
  onboard          Full setup: dtach, bot token, Claude plugin registration
  start            Start the daemon (creates systemd/launchd service)
  stop             Stop the daemon
  restart          Stop + start
  new [opts] [...]  Create a new dtach session (--title T, rest passed to claude)
  resume [id]      Attach to a dtach session (lists sessions if no id)
  status           Show daemon status + list sessions
  config           Print all config as YAML
  config <key>     Print a single config value
  config <key> <v> Set a config value (value is YAML-parsed)
  uninstall        Stop services and remove the claude shim`)
}

switch (cmd) {
    case "onboard": {
        await onboard()
        break
    }

    case "start": {
        await ensureOnboarded()
        console.log("Starting cbg daemon...")
        const out = startService()
        if (out.trim()) {
            console.log(out.trim())
        }
        console.log("Done.")
        break
    }

    case "stop": {
        console.log("Stopping cbg daemon...")
        const out = stopService()
        if (out.trim()) {
            console.log(out.trim())
        }
        console.log("Done.")
        break
    }

    case "restart": {
        await ensureOnboarded()
        console.log("Restarting cbg daemon...")
        const out = restartService()
        if (out.trim()) {
            console.log(out.trim())
        }
        console.log("Done.")
        break
    }

    case "new": {
        await ensureOnboarded()
        // Extract --title from args, pass everything else through to claude
        let title
        const claudeArgs = []
        for (let i = 0; i < args.length; i++) {
            if (args[i] === "--title" && i + 1 < args.length) {
                title = args[i + 1]
                i++ // skip the value
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
                console.log("No active dtach sessions.")
                console.log("Create one with: cbg new [title]")
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
                console.log("Active dtach sessions:")
                for (const s of sockets) {
                    console.log(`  ${s.id}  (${s.socketPath})`)
                }
                console.log("\nUsage: cbg resume <session-id>")
            }
        }
        break
    }

    case "status": {
        console.log("=== CBG Status ===\n")

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
                console.log(`Daemon: running (PID ${pid})`)
            } else {
                console.log("Daemon: not running (stale PID file)")
            }
        } catch {
            console.log("Daemon: not running")
        }

        try {
            Deno.statSync(IPC_SOCK)
            console.log(`IPC socket: ${IPC_SOCK}`)
        } catch {
            console.log("IPC socket: not found")
        }

        const sockets = listDtachSockets()
        console.log(`\nDtach sessions: ${sockets.length}`)
        for (const s of sockets) {
            console.log(`  ${s.id}  (${s.socketPath})`)
        }

        console.log("\n--- Service Status ---")
        const svcStatus = serviceStatus()
        if (svcStatus.trim()) {
            console.log(svcStatus.trim())
        }
        break
    }

    case "config": {
        if (args.length === 0) {
            const config = readConfig()
            if (Object.keys(config).length === 0) {
                console.log("# No config set yet. Use: cbg config <key> <value>")
            } else {
                console.log(stringifyYaml(config).trimEnd())
            }
        } else if (args.length === 1) {
            const val = getConfig(args[0])
            if (val === undefined) {
                console.log("(not set)")
            } else {
                console.log(typeof val === "object" ? JSON.stringify(val) : String(val))
            }
        } else {
            setConfig(args[0], args.slice(1).join(" "))
            console.log(`Set ${args[0]}`)
        }
        break
    }

    case "uninstall": {
        console.log("Uninstalling cbg...\n")

        // Stop the daemon
        console.log("Stopping daemon...")
        try {
            const out = stopService()
            if (out.trim()) {
                console.log(out.trim())
            }
        } catch {
            // may not be running
        }

        // Also kill server by PID if it's still running
        try {
            const pidStr = Deno.readTextFileSync(PID_FILE).trim()
            const pid = parseInt(pidStr)
            if (pid > 0) {
                new Deno.Command("kill", { args: [String(pid)], stdout: "null", stderr: "null" }).outputSync()
                console.log(`Killed server (PID ${pid})`)
            }
        } catch {
            // not running or no pid file
        }

        // Remove the claude shim
        console.log("Removing claude shim...")
        const shimResult = removeShim()
        console.log(`  ${shimResult.message}`)

        console.log("\nDone. cbg services stopped and claude shim removed.")
        console.log("To fully remove, delete the repo and run: deno uninstall cbg")
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
        console.error(`Unknown command: ${cmd}`)
        printUsage()
        Deno.exit(1)
    }
}
