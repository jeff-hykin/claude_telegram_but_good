/**
 * Onboarding flow for cbg: install dtach, configure bot token,
 * register Claude plugin, and verify setup.
 */

import { join, fromFileUrl } from "../imports.js"
import { ensureDtach, isDtachInstalled } from "./dtach.js"
import { readConfig, setConfig, getBotToken } from "./config.js"
import { installShim, isShimInstalled } from "./shim.js"

const HOME = Deno.env.get("HOME")

function prompt(message) {
    const buf = new Uint8Array(1024)
    Deno.stdout.writeSync(new TextEncoder().encode(message))
    const n = Deno.stdin.readSync(buf)
    return new TextDecoder().decode(buf.subarray(0, n ?? 0)).trim()
}

function promptYn(message, defaultYes = true) {
    const hint = defaultYes ? "[Y/n]" : "[y/N]"
    const answer = prompt(`${message} ${hint} `).toLowerCase()
    if (answer === "") {
        return defaultYes
    }
    return answer.startsWith("y")
}

/**
 * Run the full onboarding flow.
 */
export async function onboard() {
    console.log("=== CBG Onboarding ===\n")

    // Step 1: Install dtach
    console.log("1. Checking dtach...")
    if (isDtachInstalled()) {
        console.log("   dtach is already installed.\n")
    } else {
        console.log("   dtach not found, attempting to install...")
        if (!ensureDtach()) {
            console.error("   Failed to install dtach. Please install it manually:")
            console.error("     nix profile install nixpkgs#dtach")
            console.error("     apt-get install dtach")
            console.error("     brew install dtach")
            Deno.exit(1)
        }
        console.log("   dtach installed successfully.\n")
    }

    // Step 2: Bot token
    console.log("2. Telegram Bot Token...")
    let token = getBotToken()
    if (token) {
        const change = promptYn("   Token already configured. Change it?", false)
        if (change) {
            token = null
        } else {
            console.log("")
        }
    }
    if (!token) {
        console.log("   Open Telegram and message @BotFather:")
        console.log("   https://t.me/BotFather")
        console.log("   Send /newbot, follow the prompts, then copy the token.\n")
        token = prompt("   Paste your bot token here: ")
        if (!token || !token.includes(":")) {
            console.error("   Invalid token format. Expected something like: 123456789:AAHfiqksKZ8...")
            Deno.exit(1)
        }
        setConfig("telegram_bot_token", `"${token}"`)
        console.log("   Token saved.\n")
    }

    // Step 3: Check claude is installed
    console.log("3. Checking for Claude Code CLI...")
    const claudeCheck = new Deno.Command("which", {
        args: ["claude"],
        stdout: "piped",
        stderr: "null",
    }).outputSync()
    if (!claudeCheck.success) {
        console.error("   'claude' CLI not found on PATH.")
        console.error("   Install it from: https://docs.anthropic.com/en/docs/claude-code")
        Deno.exit(1)
    }
    console.log("   Found claude CLI.\n")

    // Step 4: Register Claude plugin
    console.log("4. Registering Claude plugin...")

    // Find the plugin source directory (this repo)
    const pluginSrcDir = join(
        import.meta.dirname ?? fromFileUrl(new URL(".", import.meta.url)),
        "..",
    )

    // Target symlink location
    const pluginDir = join(
        HOME, ".claude", "plugins", "marketplaces",
        "claude-plugins-official", "external_plugins", "telegram",
    )

    // Create symlink
    try {
        try { Deno.removeSync(pluginDir, { recursive: true }) } catch { /* ignore */ }
        Deno.mkdirSync(join(pluginDir, ".."), { recursive: true })
        Deno.symlinkSync(pluginSrcDir, pluginDir)
        console.log(`   Symlinked plugin.`)
    } catch (err) {
        console.error(`   Failed to create plugin symlink: ${err}`)
    }

    // Enable in settings.json — handle both object and array formats for enabledPlugins
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
        console.log("   Updated settings.json.\n")
    } catch (err) {
        console.error(`   Failed to update settings.json: ${err}\n`)
    }

    // Step 5: Install claude shim
    console.log("5. Installing claude shim...")
    const shimResult = installShim()
    if (shimResult.ok) {
        console.log(`   ${shimResult.message}\n`)
    } else {
        console.error(`   ${shimResult.message}\n`)
    }

    // Step 6: Verify
    console.log("6. Verifying setup...")
    const checks = [
        { name: "dtach", ok: isDtachInstalled() },
        { name: "bot token", ok: !!getBotToken() },
        {
            name: "plugin symlink",
            ok: (() => {
                try { Deno.statSync(pluginDir); return true } catch { return false }
            })(),
        },
        { name: "claude shim", ok: isShimInstalled() },
    ]

    let allOk = true
    for (const check of checks) {
        const icon = check.ok ? "OK" : "FAIL"
        console.log(`   [${icon}] ${check.name}`)
        if (!check.ok) {
            allOk = false
        }
    }

    if (allOk) {
        console.log("\n=== Setup complete! ===\n")
        console.log("Next steps:")
        console.log("  1. Run: claude")
        console.log("     (the shim automatically adds telegram support)")
        console.log("  2. DM your bot on Telegram — it will reply with a pairing command")
        console.log("  3. Paste that command into your Claude Code session")
        console.log("")
        console.log("After pairing, every `claude` session will be accessible via Telegram.")
        console.log("Use `claude --no-tele` to start a session without Telegram.")
    } else {
        console.log("\nSome checks failed. Please fix the issues above and re-run `cbg onboard`.")
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
