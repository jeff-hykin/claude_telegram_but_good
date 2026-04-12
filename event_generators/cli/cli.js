#!/usr/bin/env -S deno run -A
/**
 * cbg — CLI for Claude Telegram Bot (claude_telegram_but_good)
 */

import { colors } from "../../imports.js"
import { versionedImport } from "../../lib/version.js"

const c = colors
const [cmd, ...args] = Deno.args

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
        const { runOnboard } = await versionedImport("./commands/onboard.js", import.meta)
        await runOnboard(args)
        break
    }
    case "start": {
        const { runStart } = await versionedImport("./commands/start.js", import.meta)
        await runStart(args)
        break
    }
    case "stop": {
        const { runStop } = await versionedImport("./commands/stop.js", import.meta)
        runStop(args)
        break
    }
    case "restart": {
        const { runRestart } = await versionedImport("./commands/restart.js", import.meta)
        await runRestart(args)
        break
    }
    case "new": {
        const { runNew } = await versionedImport("./commands/new.js", import.meta)
        await runNew(args)
        break
    }
    case "resume": {
        const { runResume } = await versionedImport("./commands/resume.js", import.meta)
        await runResume(args)
        break
    }
    case "status": {
        const { runStatus } = await versionedImport("./commands/status.js", import.meta)
        runStatus(args)
        break
    }
    case "config": {
        const { runConfig } = await versionedImport("./commands/config.js", import.meta)
        runConfig(args)
        break
    }
    case "authorize": {
        const { runAuthorize } = await versionedImport("./commands/authorize.js", import.meta)
        runAuthorize(args)
        break
    }
    case "reinstall": {
        const { runReinstall } = await versionedImport("./commands/reinstall.js", import.meta)
        await runReinstall(args)
        break
    }
    case "uninstall": {
        const { runUninstall } = await versionedImport("./commands/uninstall.js", import.meta)
        await runUninstall(args)
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
