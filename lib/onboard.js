/**
 * Onboarding flow for cbg: install dtach, configure bot token,
 * register Claude plugin, pair via Telegram, install shim, and verify.
 */

import { join, colors, Input, Confirm, Select, sibling } from "../imports.js"
import { ensureDtach, isDtachInstalled } from "./dtach.js"
import { readConfig, setConfig, getBotToken } from "./config.js"
import { installShim, isShimInstalled, findClaudeBinary } from "./shim.js"
import { startService, stopService } from "./daemon.js"
import { STATE_DIR, ACCESS_FILE, PID_FILE, LOCAL_REPO, HOOK_PATH, CONFIG_FILE, dbg } from "./protocol.js"

const HOME = Deno.env.get("HOME")
const c = colors

// The hook is a bash wrapper that locates deno and runs lib/hook.js.
// We generate it at install time so the JS path points to the installed repo.
export function generateHookScript(hookJsPath) {
    return `#!/bin/bash
# Claude Code PreToolUse/PostToolUse hook — forwards events to cbg server

HOOK_JS='${hookJsPath.replace(/'/g, `'"'"'`)}'

if command -v deno &>/dev/null; then
    DENO=deno
elif [ -x "$HOME/.deno/bin/deno" ]; then
    DENO="$HOME/.deno/bin/deno"
elif [ -x "/usr/local/bin/deno" ]; then
    DENO="/usr/local/bin/deno"
else
    echo "[HOOK $(date -u +%FT%TZ)] deno not found" >> "$HOME/claud_telegram.log"
    exit 0
fi

exec "$DENO" run -A "$HOOK_JS"
`
}

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
        ok(`Token saved to ${CONFIG_FILE}`)
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

    info("Installing plugin...")
    const pluginResult = installAndSymlinkPlugin()
    if (pluginResult.ok) {
        // the .replace fixes:
        //   ✔ Installing plugin "telegram@claude-plugins-official"...
        // ✔ Successfully installed plugin: telegram@claude-plugins-official (scope: user)
        //   ✔ Plugin symlinked.
        ok(pluginResult.installOut.replace(/\n/,"\n. "))
        ok("Plugin symlinked.")
    } else {
        info(pluginResult.installOut ?? "")
        fail(pluginResult.error)
    }
    const cacheDir = pluginResult.cacheDir

    try {
        ensureSettingsJson()
        ok("Updated settings.json (plugin + hooks).")
    } catch (err) {
        fail(`settings.json update failed: ${err}`)
    }

    // --- Step 5: Permission mode ---
    header("5", "Permission Mode")
    info("How should spawned Claude sessions handle permissions?")
    console.log()

    const permChoice = await Select.prompt({
        message: c.bold.white("  Permission mode"),
        options: [
            { name: "All permissions (skip all prompts)", value: "all" },
            { name: "Auto (AI decides, some prompts)", value: "auto" },
            { name: "Accept edits (auto-approve file edits)", value: "acceptEdits" },
            { name: "Default (prompt for everything)", value: "default" },
            { name: "Plan mode (read-only, no changes)", value: "plan" },
        ],
    })

    setConfig("permission_mode", `"${permChoice}"`)

    // Write permission args to a simple file the shell shim can read
    const permFile = join(STATE_DIR, "permission_args")
    Deno.mkdirSync(STATE_DIR, { recursive: true })
    let permArgs = ""
    if (permChoice === "all") {
        permArgs = "--dangerously-skip-permissions"
    } else if (permChoice !== "default") {
        permArgs = `--permission-mode ${permChoice}`
    }
    Deno.writeTextFileSync(permFile, permArgs)
    ok(`Permission mode: ${permChoice}`)

    // --- Step 6: Start service ---
    header("6", "Daemon Service")
    info("Stopping any existing server...")
    try { stopService() } catch (e) { dbg("ONBOARD", "stopService:", e) }
    info("Starting Telegram bot server...")
    startService()
    const serverReady = await waitForServer()
    if (!serverReady) {
        fail("Server failed to start. Check your bot token.")
        Deno.exit(1)
    }
    ok("Bot server running.")

    // --- Step 7: Telegram pairing ---
    header("7", "Telegram Pairing")

    // Check if already paired
    const existingAllowFrom = readAccessAllowFrom()
    if (existingAllowFrom.length > 0) {
        ok(`Already paired (${existingAllowFrom.length} user(s) on allowlist).`)
        const repair = await Confirm.prompt({
            message: c.dim("  Pair another account?"),
            default: false,
        })
        if (!repair) {
            await doShimAndVerify(cacheDir)
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

    await doShimAndVerify(cacheDir)
}

async function doShimAndVerify(pluginDir) {
    // --- Step 8: Claude shim ---
    header("8", "Claude Shim")
    info("Wraps the claude command to auto-add Telegram + dtach.")
    const shimResult = installShim()
    if (shimResult.ok) {
        ok(shimResult.message)
    } else {
        fail(shimResult.message)
    }

    // --- Step 9: Verify ---
    header("9", "Verification")
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
        console.log("    Run " + c.cyan("/list") + " on Telegram to connect to your Claude sessions.")
        console.log("    Tap a session to start messaging it.")
        info(c.dim("Note: only new claude terminals will be visible."))
        console.log()
        console.log(c.dim("  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500"))
        console.log(c.dim("  Tip: ") + c.white("claude --no-tele") + c.dim(" to hide a session from Telegram"))
        console.log(c.dim("       ") + c.white("cbg uninstall") + c.dim("    to remove everything"))
        console.log()
    } else {
        console.log(c.bold.yellow("  \u26A0 Some checks failed. Fix the issues above and re-run ") + c.white("cbg onboard"))
        console.log()
    }
}

/**
 * Ensure settings.json has the plugin enabled and hooks configured.
 * Idempotent — safe to call on every reinstall/onboard.
 */
export function ensureSettingsJson() {
    const settingsPath = join(HOME, ".claude", "settings.json")
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

    // Configure tool call hooks for Telegram status updates
    const hookEntry = {
        type: "command",
        command: HOOK_PATH,
        timeout: 5,
    }
    if (!settings.hooks) {
        settings.hooks = {}
    }
    for (const event of ["PreToolUse", "PostToolUse"]) {
        if (!settings.hooks[event]) {
            settings.hooks[event] = []
        }
        // Update any old hook paths
        for (const matcher of settings.hooks[event]) {
            for (const h of (matcher.hooks ?? [])) {
                if (h.command && h.command !== HOOK_PATH && h.command.includes("hook")) {
                    h.command = HOOK_PATH
                }
            }
        }
        // Add hook entry if not present
        const found = settings.hooks[event].find(m => m.matcher === "*" && m.hooks?.some(h => h.command === HOOK_PATH))
        if (!found) {
            settings.hooks[event].push({ matcher: "*", hooks: [hookEntry] })
        }
    }

    Deno.writeTextFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n")
}

/**
 * Install the telegram plugin via Claude CLI and patch its entrypoint.
 * Clones/updates the repo to ~/.local/share/cbg/plugin, then rewrites .mcp.json
 * in the Claude plugin cache and external_plugins directories to point at the local repo.
 * Returns { ok, cacheDir, installOut } or { ok: false, error }.
 */
export function installAndSymlinkPlugin() {
    const REPO_URL = "https://github.com/jeff-hykin/claude_telegram_but_good.git"
    const localRepo = LOCAL_REPO

    // If CBG_DEV is set, symlink to the dev repo instead of cloning
    const devPath = Deno.env.get("CBG_DEV")
    if (devPath) {
        try { Deno.removeSync(localRepo, { recursive: true }) } catch (e) { dbg("ONBOARD", "removeSync localRepo:", e) }
        Deno.mkdirSync(join(localRepo, ".."), { recursive: true })
        Deno.symlinkSync(devPath, localRepo)
    } else {
        // Clone or update
        try {
            if (Deno.statSync(join(localRepo, ".git")).isDirectory) {
                new Deno.Command("git", {
                    args: ["-C", localRepo, "pull", "origin", "--ff-only"],
                    stdout: "null", stderr: "null",
                }).outputSync()
            }
        } catch (e) {
            dbg("ONBOARD", "git pull failed, cloning fresh:", e)
            try { Deno.removeSync(localRepo, { recursive: true }) } catch (e2) { dbg("ONBOARD", "removeSync localRepo:", e2) }
            Deno.mkdirSync(join(localRepo, ".."), { recursive: true })
            new Deno.Command("git", {
                args: ["clone", "--depth", "1", REPO_URL, localRepo],
                stdout: "piped", stderr: "piped",
            }).outputSync()
        }
    }
    const claudeBin = findClaudeBinary()
    const realClaude = claudeBin?.realPath ?? "claude"

    // Install via Claude CLI so it registers properly
    const installResult = new Deno.Command(realClaude, {
        args: ["plugin", "install", "telegram@claude-plugins-official", "-s", "user"],
        stdout: "piped", stderr: "piped",
    }).outputSync()
    const installOut = new TextDecoder().decode(installResult.stdout).trim()
        || new TextDecoder().decode(installResult.stderr).trim()

    // Find the versioned cache dir (e.g. 0.0.4)
    const cacheBase = join(HOME, ".claude", "plugins", "cache", "claude-plugins-official", "telegram")
    let maxVer = ""
    try {
        for (const entry of Deno.readDirSync(cacheBase)) {
            if (entry.name > maxVer) { maxVer = entry.name }
        }
    } catch { /* ignore */ }

    if (!maxVer) {
        return { ok: false, error: "Could not find plugin cache directory after install", installOut }
    }

    const cacheDir = join(cacheBase, maxVer)
    const extDir = join(HOME, ".claude", "plugins", "marketplaces", "claude-plugins-official", "external_plugins", "telegram")

    // Patch .mcp.json in both cache and external_plugins to point at the local repo
    const patchedMcp = JSON.stringify({
        mcpServers: {
            telegram: {
                command: "sh",
                args: ["-c", `SESSION_CWD="$PWD" deno run -A "${localRepo}/shim.js"`],
            },
        },
    }, null, 2) + "\n"
    for (const target of [cacheDir, extDir]) {
        const mcpPath = join(target, ".mcp.json")
        try { Deno.mkdirSync(target, { recursive: true }) } catch { /* ignore */ }
        Deno.writeTextFileSync(mcpPath, patchedMcp)
    }

    return { ok: true, cacheDir, installOut }
}

export function isOnboarded() {
    if (!isDtachInstalled()) {
        return false
    }
    if (!getBotToken()) {
        return false
    }
    const pluginCacheBase = join(HOME, ".claude", "plugins", "cache", "claude-plugins-official", "telegram")
    try {
        const entries = Array.from(Deno.readDirSync(pluginCacheBase))
        return entries.length > 0
    } catch {
        return false
    }
}
