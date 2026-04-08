/**
 * Onboarding flow for cbg: install dtach, configure bot token,
 * register Claude plugin, pair via Telegram, install shim, and verify.
 */

import { join, fromFileUrl, colors, Input, Confirm } from "../imports.js"
import { ensureDtach, isDtachInstalled } from "./dtach.js"
import { readConfig, setConfig, getBotToken } from "./config.js"
import { installShim, isShimInstalled } from "./shim.js"
import { STATE_DIR, ACCESS_FILE, PID_FILE } from "./protocol.js"

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
    console.log(c.green(`  \u2714 ${msg}`))
}

function info(msg) {
    console.log(c.dim(`    ${msg}`))
}

function warn(msg) {
    console.log(c.yellow(`  \u26A0 ${msg}`))
}

function fail(msg) {
    console.log(c.red(`  \u2716 ${msg}`))
}

function randomPasscode() {
    const arr = new Uint8Array(4)
    crypto.getRandomValues(arr)
    return Array.from(arr, b => b.toString(16).padStart(2, "0")).join("")
}

function readAccessAllowFrom() {
    try {
        const raw = Deno.readTextFileSync(ACCESS_FILE)
        const access = JSON.parse(raw)
        return access.allowFrom ?? []
    } catch {
        return []
    }
}

/**
 * Start the standalone server in the background.
 * Returns the child process (unref'd).
 */
function startServerBackground() {
    const serverScript = join(
        import.meta.dirname ?? fromFileUrl(new URL(".", import.meta.url)),
        "..",
        "standalone-server.js",
    )
    const child = new Deno.Command("deno", {
        args: ["run", "-A", serverScript],
        stdout: "null",
        stderr: "null",
        stdin: "null",
    }).spawn()
    child.unref()
    return child
}

/**
 * Wait for the standalone server to be ready (PID file appears).
 */
async function waitForServer(timeoutMs = 15000) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        try {
            const pidStr = Deno.readTextFileSync(PID_FILE).trim()
            const pid = parseInt(pidStr)
            if (pid > 0) {
                const check = new Deno.Command("kill", {
                    args: ["-0", String(pid)],
                    stdout: "null",
                    stderr: "null",
                }).outputSync()
                if (check.success) {
                    return true
                }
            }
        } catch {
            // not ready yet
        }
        await new Promise(r => setTimeout(r, 500))
    }
    return false
}

/**
 * Run the full onboarding flow.
 */
export async function onboard() {
    console.log()
    console.log(c.bold.cyan("  \u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557"))
    console.log(c.bold.cyan("  \u2551   ") + c.bold.white("      CBG Onboarding         ") + c.bold.cyan("\u2551"))
    console.log(c.bold.cyan("  \u2551   ") + c.dim(" Claude Telegram But Good    ") + c.bold.cyan("\u2551"))
    console.log(c.bold.cyan("  \u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D"))

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
        console.log("    " + c.bold.cyan(link("https://t.me/BotFather", "https://t.me/BotFather")))
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
        console.log("    " + c.bold.cyan(link("https://docs.anthropic.com/en/docs/claude-code", "https://docs.anthropic.com/en/docs/claude-code")))
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

    // --- Step 5: Telegram pairing ---
    header("5", "Telegram Pairing")

    // Check if already paired
    const existingAllowFrom = readAccessAllowFrom()
    if (existingAllowFrom.length > 0) {
        ok(`Already paired (${existingAllowFrom.length} user(s) on allowlist).`)
        const repair = await Confirm.prompt({
            message: c.dim("  Pair another account?"),
            default: false,
        })
        if (!repair) {
            // Skip to shim
            await doShimAndVerify(pluginDir)
            return
        }
    }

    // Generate a one-time password
    const otp = randomPasscode()
    const otpFile = join(STATE_DIR, "pending_otp.json")
    Deno.mkdirSync(STATE_DIR, { recursive: true })
    Deno.writeTextFileSync(otpFile, JSON.stringify({
        code: otp,
    }))

    // Start the server so the bot can receive messages
    info("Starting Telegram bot server...")
    startServerBackground()
    const serverReady = await waitForServer()
    if (!serverReady) {
        fail("Server failed to start. Check your bot token.")
        try { Deno.removeSync(otpFile) } catch { /* ignore */ }
        Deno.exit(1)
    }
    ok("Bot server running.")
    console.log()

    // Tell the user to message the bot
    console.log(c.bold.white("    Approve your account, send this in telegram (to your bot):"))
    console.log(c.dim("    Tip: the BotFather sent you a link to your bot, click it"))
    console.log()
    console.log(c.bold.cyan(`      /approve_user one_time_password:${otp}`))
    console.log()
    info("Waiting for pairing...")
    console.log()

    // Poll access.json for a new entry
    const beforeCount = existingAllowFrom.length
    let paired = false

    while (true) {
        const current = readAccessAllowFrom()
        if (current.length > beforeCount) {
            paired = true
            break
        }
        await new Promise(r => setTimeout(r, 1500))
    }

    const current = readAccessAllowFrom()
    const newId = current[current.length - 1]
    ok(`Paired! User ${newId} added to allowlist.`)

    await doShimAndVerify(pluginDir)
}

async function doShimAndVerify(pluginDir) {
    // --- Step 6: Claude shim ---
    header("6", "Claude Shim")
    info("Wraps the claude command to auto-add Telegram + dtach.")
    const shimResult = installShim()
    if (shimResult.ok) {
        ok(shimResult.message)
    } else {
        fail(shimResult.message)
    }

    // --- Step 7: Verify ---
    header("7", "Verification")
    const checks = [
        { name: "dtach", ok: isDtachInstalled() },
        { name: "bot token", ok: !!getBotToken() },
        {
            name: "plugin",
            ok: (() => {
                try { Deno.statSync(pluginDir); return true } catch { return false }
            })(),
        },
        { name: "paired", ok: readAccessAllowFrom().length > 0 },
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
        console.log(c.bold.green("  \u2714 Setup complete!"))
        console.log()
        console.log(c.bold.white("  You're all set. Just run:"))
        console.log()
        console.log(c.bold.cyan("    claude"))
        console.log()
        info("The shim auto-adds Telegram channels + dtach.")
        info("Every session is accessible from your Telegram bot.")
        console.log()
        console.log(c.dim("  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500"))
        console.log(c.dim("  Tip: ") + c.white("claude --no-tele") + c.dim(" for sessions without Telegram"))
        console.log(c.dim("       ") + c.white("cbg uninstall") + c.dim("    to remove the shim"))
        console.log()
    } else {
        console.log(c.bold.yellow("  \u26A0 Some checks failed. Fix the issues above and re-run ") + c.white("cbg onboard"))
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
