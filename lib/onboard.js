/**
 * Onboarding flow for cbg: install dtach, configure bot token,
 * register Claude plugin, install shim, and verify setup.
 */

import { join, fromFileUrl, colors, Input, Confirm } from "../imports.js"
import { ensureDtach, isDtachInstalled } from "./dtach.js"
import { readConfig, setConfig, getBotToken } from "./config.js"
import { installShim, isShimInstalled } from "./shim.js"

const HOME = Deno.env.get("HOME")
const c = colors

function header(step, title) {
    console.log(c.bold.white(`\n  [${step}] ${title}`))
    console.log(c.dim("  " + "─".repeat(50)))
}

function link(url, label) {
    return `\x1b]8;;${url}\x1b\\${label ?? url}\x1b]8;;\x1b\\`
}

function ok(msg) {
    console.log(c.green(`  ✔ ${msg}`))
}

function info(msg) {
    console.log(c.dim(`    ${msg}`))
}

function warn(msg) {
    console.log(c.yellow(`  ⚠ ${msg}`))
}

function fail(msg) {
    console.log(c.red(`  ✖ ${msg}`))
}

/**
 * Run the full onboarding flow.
 */
export async function onboard() {
    console.log()
    console.log(c.bold.cyan("  ╔════════════════════════════════╗"))
    console.log(c.bold.cyan("  ║   ") + c.bold.white("CBG Onboarding             ") + c.bold.cyan("║"))
    console.log(c.bold.cyan("  ║   ") + c.dim("Claude Telegram But Good    ") + c.bold.cyan("║"))
    console.log(c.bold.cyan("  ╚════════════════════════════════╝"))

    // --- Step 1: dtach ---
    header("1", "Terminal Multiplexer (dtach)")
    if (isDtachInstalled()) {
        ok("dtach is installed.")
    } else {
        info("dtach lets you detach/reattach Claude sessions.")
        info("Attempting to install...")
        if (ensureDtach()) {
            ok("dtach installed successfully.")
        } else {
            fail("Could not install dtach automatically.")
            console.log()
            info("Install it manually with one of:")
            info(c.white("  nix profile install nixpkgs#dtach"))
            info(c.white("  apt-get install dtach"))
            info(c.white("  brew install dtach"))
            Deno.exit(1)
        }
    }

    // --- Step 2: Bot token ---
    header("2", "Telegram Bot Token")
    let token = getBotToken()
    if (token) {
        ok("Token already configured.")
        const change = await Confirm.prompt({
            message: c.dim("  Change it?"),
            default: false,
        })
        if (change) {
            token = null
        }
    }
    if (!token) {
        console.log()
        info("Create a bot via BotFather on Telegram:")
        console.log("    " + c.bold.cyan(link("https://t.me/BotFather", "@BotFather")))
        console.log()
        info("Send " + c.white("/newbot") + ", follow the prompts, then copy the token.")
        console.log()

        token = await Input.prompt({
            message: c.bold.white("  Paste your bot token"),
            validate: (v) => {
                if (!v.includes(":")) {
                    return "Token should look like: 123456789:AAHfiqksKZ8..."
                }
                return true
            },
        })
        setConfig("telegram_bot_token", `"${token}"`)
        ok("Token saved to ~/.config/cbg/config.yaml")
    }

    // --- Step 3: Claude CLI ---
    header("3", "Claude Code CLI")
    const claudeCheck = new Deno.Command("which", {
        args: ["claude"],
        stdout: "piped",
        stderr: "null",
    }).outputSync()
    if (!claudeCheck.success) {
        fail("'claude' CLI not found on PATH.")
        info("Install it from:")
        console.log("    " + c.bold.cyan(link("https://docs.anthropic.com/en/docs/claude-code", "Claude Code docs")))
        Deno.exit(1)
    }
    ok("Found claude CLI.")

    // --- Step 4: Plugin registration ---
    header("4", "Plugin Registration")

    const pluginSrcDir = join(
        import.meta.dirname ?? fromFileUrl(new URL(".", import.meta.url)),
        "..",
    )
    const pluginDir = join(
        HOME, ".claude", "plugins", "marketplaces",
        "claude-plugins-official", "external_plugins", "telegram",
    )

    try {
        try { Deno.removeSync(pluginDir, { recursive: true }) } catch { /* ignore */ }
        Deno.mkdirSync(join(pluginDir, ".."), { recursive: true })
        Deno.symlinkSync(pluginSrcDir, pluginDir)
        ok("Plugin symlinked.")
    } catch (err) {
        fail(`Symlink failed: ${err}`)
    }

    // Enable in settings.json — handle both object and array formats
    const settingsPath = join(HOME, ".claude", "settings.json")
    try {
        let settings = {}
        try {
            settings = JSON.parse(Deno.readTextFileSync(settingsPath))
        } catch {
            // start fresh
        }

        if (!settings.channelsEnabled) {
            settings.channelsEnabled = true
        }

        const pluginId = "telegram@claude-plugins-official"
        const ep = settings.enabledPlugins
        if (Array.isArray(ep)) {
            if (!ep.includes(pluginId)) {
                ep.push(pluginId)
            }
        } else if (ep && typeof ep === "object") {
            ep[pluginId] = true
        } else {
            settings.enabledPlugins = { [pluginId]: true }
        }

        Deno.writeTextFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n")
        ok("Updated settings.json.")
    } catch (err) {
        fail(`settings.json update failed: ${err}`)
    }

    // --- Step 5: Claude shim ---
    header("5", "Claude Shim")
    info("Wraps the claude command to auto-add Telegram + dtach.")
    const shimResult = installShim()
    if (shimResult.ok) {
        ok(shimResult.message)
    } else {
        fail(shimResult.message)
    }

    // --- Step 6: Verify ---
    header("6", "Verification")
    const checks = [
        { name: "dtach", ok: isDtachInstalled() },
        { name: "bot token", ok: !!getBotToken() },
        {
            name: "plugin",
            ok: (() => {
                try { Deno.statSync(pluginDir); return true } catch { return false }
            })(),
        },
        { name: "claude shim", ok: isShimInstalled() },
    ]

    let allOk = true
    for (const check of checks) {
        if (check.ok) {
            ok(check.name)
        } else {
            fail(check.name)
            allOk = false
        }
    }

    // --- Finish ---
    console.log()
    if (allOk) {
        console.log(c.bold.green("  ✔ Setup complete!"))
        console.log()
        console.log(c.bold.white("  Next steps:"))
        console.log()
        console.log(c.dim("    1. ") + "Run " + c.bold.cyan("claude"))
        console.log(c.dim("       ") + c.dim("(the shim auto-adds Telegram + dtach)"))
        console.log()
        console.log(c.dim("    2. ") + "DM your bot on Telegram")
        console.log(c.dim("       ") + c.dim("It will reply with a pairing command"))
        console.log()
        console.log(c.dim("    3. ") + "Paste the " + c.white("/telegram:access pair ...") + " command")
        console.log(c.dim("       ") + c.dim("into your Claude Code session"))
        console.log()
        console.log(c.dim("  ─────────────────────────────────────────"))
        console.log(c.dim("  Tip: use ") + c.white("claude --no-tele") + c.dim(" for sessions without Telegram"))
        console.log(c.dim("       use ") + c.white("cbg uninstall") + c.dim(" to remove the shim"))
        console.log()
    } else {
        console.log(c.bold.yellow("  ⚠ Some checks failed. Fix the issues above and re-run ") + c.white("cbg onboard"))
        console.log()
    }
}

/**
 * Check if onboarding is complete (all prerequisites met).
 */
export function isOnboarded() {
    if (!isDtachInstalled()) {
        return false
    }
    if (!getBotToken()) {
        return false
    }
    const pluginDir = join(
        HOME, ".claude", "plugins", "marketplaces",
        "claude-plugins-official", "external_plugins", "telegram",
    )
    try {
        Deno.statSync(pluginDir)
        return true
    } catch {
        return false
    }
}
