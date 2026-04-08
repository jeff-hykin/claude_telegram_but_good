/**
 * Onboarding flow for cbg: install dtach, configure bot token,
 * register Claude plugin, and verify setup.
 */

import { join, fromFileUrl } from "../imports.js"
import { ensureDtach, isDtachInstalled } from "./dtach.js"
import { readConfig, setConfig, getBotToken } from "./config.js"

const HOME = Deno.env.get("HOME")

function prompt(message) {
    const buf = new Uint8Array(1024)
    Deno.stdout.writeSync(new TextEncoder().encode(message))
    const n = Deno.stdin.readSync(buf)
    return new TextDecoder().decode(buf.subarray(0, n ?? 0)).trim()
}

/**
 * Run the full onboarding flow.
 */
export async function onboard() {
    console.log("=== CBG Onboarding ===\n")

    // Step 1: Install dtach
    console.log("1. Checking dtach...")
    if (isDtachInstalled()) {
        console.log("   dtach is already installed.")
    } else {
        console.log("   dtach not found, attempting to install...")
        if (!ensureDtach()) {
            console.error("   Failed to install dtach. Please install it manually:")
            console.error("     nix profile install nixpkgs#dtach")
            console.error("     apt-get install dtach")
            console.error("     brew install dtach")
            Deno.exit(1)
        }
        console.log("   dtach installed successfully.")
    }

    // Step 2: Bot token
    console.log("\n2. Telegram Bot Token...")
    let token = getBotToken()
    if (token) {
        console.log("   Token already configured.")
    } else {
        token = prompt("   Enter your Telegram bot token: ")
        if (!token || !token.includes(":")) {
            console.error("   Invalid token format. Expected: 123456789:AAH...")
            Deno.exit(1)
        }
        setConfig("telegram_bot_token", `"${token}"`)
        console.log("   Token saved to config.")
    }

    // Step 3: Register Claude plugin
    console.log("\n3. Registering Claude plugin...")

    const claudeCheck = new Deno.Command("which", {
        args: ["claude"],
        stdout: "piped",
        stderr: "null",
    }).outputSync()
    if (!claudeCheck.success) {
        console.error("   'claude' CLI not found. Please install Claude Code first.")
        Deno.exit(1)
    }

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
        console.log(`   Symlinked plugin: ${pluginDir} -> ${pluginSrcDir}`)
    } catch (err) {
        console.error(`   Failed to create plugin symlink: ${err}`)
    }

    // Enable in settings.json
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

        const enabledPlugins = settings.enabledPlugins ?? []
        const pluginId = "telegram@claude-plugins-official"
        if (!enabledPlugins.includes(pluginId)) {
            enabledPlugins.push(pluginId)
            settings.enabledPlugins = enabledPlugins
        }

        Deno.writeTextFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n")
        console.log("   Updated ~/.claude/settings.json (channelsEnabled + plugin)")
    } catch (err) {
        console.error(`   Failed to update settings.json: ${err}`)
    }

    // Step 4: Verify
    console.log("\n4. Verifying setup...")
    const checks = [
        { name: "dtach", ok: isDtachInstalled() },
        { name: "bot token", ok: !!getBotToken() },
        {
            name: "plugin symlink",
            ok: (() => {
                try { Deno.statSync(pluginDir); return true } catch { return false }
            })(),
        },
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
        console.log("\nOnboarding complete! Run `cbg start` to start the daemon.")
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
