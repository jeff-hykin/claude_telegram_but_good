// ---------------------------------------------------------------------------
// event-generators/cli/helpers.js
//
// One stop for all install / onboard / reinstall / uninstall logic. Keeping
// these in a single file is deliberate: if `onboard` installs something,
// `uninstall` has to know how to rip it out again, and vice versa. Splitting
// that knowledge across files is how files and the filesystem get out of
// sync — so everything lives here.
//
// Used by the CLI subcommands under event-generators/cli/commands/. Nothing
// in the daemon, shim, or event handlers pulls from this file — it's purely
// install-time orchestration.
// ---------------------------------------------------------------------------

import { versionedImport } from "../../lib/version.js"

const [
    { join, colors, Input, Confirm, Select },
    { stopService, startService, isDaemonRunning },
    { ensureDtach, isDtachInstalled },
    {
        getBotToken,
        setBotToken,
        setPermissionMode,
    },
    { installShim, isShimInstalled, findClaudeBinary },
    { paths },
    { dbg },
    { encodeIpcFrame },
    { buildPatchedMcpJson },
    { installHooks, uninstallHooks },
] = await Promise.all([
    versionedImport("../../imports.js", import.meta),
    versionedImport("../../lib/daemon.js", import.meta),
    versionedImport("../../lib/dtach.js", import.meta),
    versionedImport("../../lib/config-manager.js", import.meta),
    versionedImport("./shim-setup.js", import.meta),
    versionedImport("../../lib/paths.js", import.meta),
    versionedImport("../../lib/logging.js", import.meta),
    versionedImport("../../lib/ipc.js", import.meta),
    versionedImport("../mcp-server/setup.js", import.meta),
    versionedImport("../hooks/setup.js", import.meta),
])
const c = colors

// ── CLI → daemon IPC (one-shot request/response) ──────────────────────
//
// `sendCliCommand` previously lived in event-generators/cli/ipc-client.js
// as a standalone module. It had exactly two callers — this file and
// commands/authorize.js — and both are now in the install-time
// orchestration family that already lives here. Inlining it means one
// less file and makes the CLI's IPC usage visible at the same depth as
// the onboard/authorize flows that use it.

const _cliReplyDecoder = new TextDecoder()

/**
 * Send a one-shot `cli_command` to the daemon and await its reply.
 *
 * Connects to paths.IPC_SOCK, writes one newline-JSON frame (via
 * encodeIpcFrame — the framing format lives only in lib/ipc.js), reads
 * lines until a JSON line arrives, parses it, and returns it. Closes
 * the connection afterwards.
 *
 * Throws if:
 *   - The daemon is not running (ECONNREFUSED / NotFound) — the error
 *     message hints at running `cbg start`.
 *   - The timeout elapses before a reply arrives.
 *   - The reply isn't valid JSON.
 */
export async function sendCliCommand(kind, payload = {}, { timeoutMs = 5000 } = {}) {
    let conn
    try {
        conn = await Deno.connect({ transport: "unix", path: paths.IPC_SOCK })
    } catch (e) {
        if (e instanceof Deno.errors.ConnectionRefused || e instanceof Deno.errors.NotFound) {
            dbg("IPC-CLIENT", `daemon unreachable at ${paths.IPC_SOCK}:`, e)
            throw new Error(`cbg daemon not running (IPC socket unreachable at ${paths.IPC_SOCK}). Try 'cbg start' first.`)
        }
        dbg("IPC-CLIENT", "unexpected connect error:", e)
        throw e
    }

    let timeoutHandle = null
    const timeoutPromise = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
            reject(new Error(`cbg daemon did not reply within ${timeoutMs}ms for cli_command kind=${kind}`))
        }, timeoutMs)
    })

    try {
        // Awaiting the write ourselves so any encode/write failure
        // surfaces before we start waiting for a reply that can never
        // come. (Fire-and-forget wouldn't catch write errors.)
        await conn.write(encodeIpcFrame({ type: "cli_command", kind, payload }))

        const readPromise = (async () => {
            const buf = new Uint8Array(8 * 1024)
            let pending = ""
            while (true) {
                const n = await conn.read(buf)
                if (n === null) {
                    throw new Error(`cbg daemon closed connection before replying to cli_command kind=${kind}`)
                }
                pending += _cliReplyDecoder.decode(buf.subarray(0, n))
                const nl = pending.indexOf("\n")
                if (nl !== -1) {
                    const line = pending.slice(0, nl)
                    try {
                        return JSON.parse(line)
                    } catch (e) {
                        dbg("IPC-CLIENT", `invalid JSON reply for kind=${kind}:`, line, e)
                        throw new Error(`cbg daemon sent invalid JSON reply for cli_command kind=${kind}: ${line}`)
                    }
                }
            }
        })()

        const reply = await Promise.race([readPromise, timeoutPromise])
        return reply
    } catch (e) {
        dbg("IPC-CLIENT", `cli_command kind=${kind} failed:`, e)
        throw e
    } finally {
        if (timeoutHandle !== null) {
            clearTimeout(timeoutHandle)
        }
        try {
            conn.close()
        } catch (e) {
            dbg("IPC-CLIENT", "error closing connection:", e)
        }
    }
}

/**
 * Hot-reload the running daemon without dropping any shim connections.
 *
 * Sends a `reload_cbg` cli_command over IPC. The server handler emits a
 * `bump_cbg_version` effect, which:
 *   1. rewrites `lib/version.js` in place with a new VERSION constant,
 *   2. updates `globalThis.cbgVersion` on the server so the next
 *      `versionedImport(...)` inside the event loop produces a fresh
 *      module URL and Deno re-fetches the whole module graph,
 *   3. broadcasts `{ type: "version_bumped", version }` to every shim
 *      currently registered in `core.chatSessions`, so those shims
 *      also update their own `globalThis.cbgVersion` and pick up new
 *      code on their next tool call.
 *
 * No IPC connections are closed, no Claude sessions are restarted, and
 * no setuid/systemd churn happens. The server resolves to `{ ok: true,
 * version: N }` where N is the new version number.
 *
 * Throws if the daemon isn't reachable at paths.IPC_SOCK.
 */
export async function hotReloadDaemon() {
    return await sendCliCommand("reload_cbg", {})
}

// ── Daemon lifecycle ───────────────────────────────────────────────────

export function killAllServers({ markStopped = true } = {}) {
    Deno.mkdirSync(paths.STATE_DIR, { recursive: true })
    if (markStopped) {
        Deno.writeTextFileSync(paths.STOPPED_FILE, String(Date.now()))
    }
    try { stopService() } catch (e) { dbg("CBG", "stopService failed (may not be running):", e) }
    try {
        const pidStr = Deno.readTextFileSync(paths.PID_FILE).trim()
        const pid = parseInt(pidStr)
        if (pid > 0) {
            new Deno.Command("kill", { args: [String(pid)], stdout: "null", stderr: "null" }).outputSync()
        }
    } catch (e) {
        dbg("CBG", "kill server by PID failed:", e)
    }
    try {
        new Deno.Command("pkill", {
            args: ["-f", "standalone-server\\.js"],
            stdout: "null", stderr: "null",
        }).outputSync()
    } catch (e) {
        dbg("CBG", "pkill standalone-server failed:", e)
    }
}

/**
 * Wait for the standalone server to be ready (PID file appears + the
 * process is actually alive).
 *
 * The daemon takes a few seconds to spin up during first-time
 * onboarding. While we're waiting, `PID_FILE` obviously doesn't exist
 * yet — ENOENT from `readTextFileSync` is the EXPECTED state for
 * every poll until the server wins its race. We used to log each
 * miss via `dbg("ONBOARD", ...)`, which produced ~20 lines of
 * "waitForServer poll: ENOENT" noise during onboarding. Now: swallow
 * ENOENT entirely (it's expected), surface any OTHER error once per
 * poll, and log a single timeout message if we give up.
 */
async function waitForServer(timeoutMs = 15000) {
    const start = Date.now()
    let lastErr = null
    while (Date.now() - start < timeoutMs) {
        try {
            const pidStr = Deno.readTextFileSync(paths.PID_FILE).trim()
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
        } catch (e) {
            // ENOENT / NotFound is expected: the daemon hasn't
            // written PID_FILE yet. Quietly wait for it. Any other
            // error (permission, corrupt read, etc.) is worth
            // surfacing, but only once at timeout so we don't spam.
            if (!(e instanceof Deno.errors.NotFound)) {
                lastErr = e
            }
        }
        await new Promise(r => setTimeout(r, 500))
    }
    if (lastErr) {
        dbg("ONBOARD", "waitForServer gave up after repeated errors:", lastErr)
    } else {
        dbg("ONBOARD", `waitForServer timed out after ${timeoutMs}ms (no PID_FILE appeared)`)
    }
    return false
}

// ── Pretty-print helpers for the onboard flow ──────────────────────────

function header(step, title) {
    console.log(c.bold.white(`\n  [${step}] ${title}`))
    console.log(c.dim("  " + "─".repeat(50)))
}

function link(url, label) {
    return `\x1b]8;;${url}\x1b\\${label ?? url}\x1b]8;;\x1b\\`
}

function ok(msg) { console.log(c.green(`  \u2714 ${msg}`)) }
function info(msg) { console.log(c.dim(`    ${msg}`)) }
function warn(msg) { console.log(c.yellow(`  \u26A0 ${msg}`)) }
function fail(msg) { console.log(c.red(`  \u2716 ${msg}`)) }

function randomPasscode() {
    const arr = new Uint8Array(4)
    crypto.getRandomValues(arr)
    return Array.from(arr, b => b.toString(16).padStart(2, "0")).join("")
}

/**
 * Generate a pairing one-time password, stash it in the running daemon's
 * chatState.pendingOtps via a cli_command, and print the pairing code to
 * the console. Returns the OTP string so callers that want to watch for
 * the resulting allowlist entry (e.g. the onboard flow) can do so.
 *
 * Shared by `cbg authorize` (add another paired user) and `cbg onboard`
 * (pair the first user). Exits with code 1 if the daemon is unreachable
 * or rejects the stash — the user can't make progress from either flow
 * without a running daemon.
 */
export async function authorize() {
    const otp = randomPasscode()
    try {
        const reply = await sendCliCommand("set_pending_otp", { otp })
        if (!reply?.ok) {
            fail(`daemon rejected set_pending_otp: ${reply?.error ?? "unknown"}`)
            Deno.exit(1)
        }
    } catch (e) {
        fail(`Could not reach the daemon: ${e?.message ?? e}`)
        info("Start it with `cbg start` and try again.")
        Deno.exit(1)
    }
    console.log()
    console.log(c.bold.white("  Pairing code ready. Send this in Telegram to your bot:"))
    console.log()
    console.log(c.bold.cyan(`    /approve_user one_time_password:${otp}`))
    console.log()
    return otp
}

function readAccessAllowFrom() {
    try {
        const raw = Deno.readTextFileSync(paths.ACCESS_FILE)
        const access = JSON.parse(raw)
        return access.allowFrom ?? []
    } catch (e) {
        dbg("ONBOARD", "readAccessAllowFrom:", e)
        return []
    }
}

// ── settings.json manipulation (install + uninstall pair) ─────────────
//
// ensureSettingsJson() and removeFromSettingsJson() are the two halves of
// the same contract: anything the installer ADDS here, the uninstaller
// must be able to REMOVE. Keep their field sets in sync.
//
// Hook-specific entries live in event-generators/hooks/setup.js so the
// hook's knowledge of what it needs in settings.json lives next to the
// hook itself. This file just handles the plugin fields and owns the
// read/write of the file.

const PLUGIN_ID = "telegram@claude-plugins-official"

function readSettings(label) {
    try {
        return JSON.parse(Deno.readTextFileSync(paths.CLAUDE_SETTINGS))
    } catch (e) {
        dbg(label, "settings.json read failed:", e)
        return {}
    }
}

function writeSettings(settings) {
    Deno.writeTextFileSync(paths.CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + "\n")
}

/**
 * Ensure settings.json has the plugin enabled and cbg hooks registered.
 * Idempotent — safe to call on every reinstall/onboard.
 */
export function ensureSettingsJson() {
    const settings = readSettings("ONBOARD")

    if (!settings.channelsEnabled) {
        settings.channelsEnabled = true
    }

    const ep = settings.enabledPlugins
    if (Array.isArray(ep)) {
        if (!ep.includes(PLUGIN_ID)) {
            ep.push(PLUGIN_ID)
        }
    } else if (ep && typeof ep === "object") {
        ep[PLUGIN_ID] = true
    } else {
        settings.enabledPlugins = { [PLUGIN_ID]: true }
    }

    installHooks(settings)
    writeSettings(settings)
}

/**
 * Remove cbg hooks and the plugin from settings.json. Mirrors
 * ensureSettingsJson — any field added there must be cleaned up here.
 */
export function removeFromSettingsJson() {
    const settings = readSettings("UNINSTALL")

    uninstallHooks(settings)

    const ep = settings.enabledPlugins
    if (Array.isArray(ep)) {
        settings.enabledPlugins = ep.filter(p => p !== PLUGIN_ID)
    } else if (ep && typeof ep === "object") {
        delete ep[PLUGIN_ID]
    }

    writeSettings(settings)
}

// ── Plugin install ────────────────────────────────────────────────────

/**
 * Install the telegram plugin via the Claude CLI and patch its .mcp.json
 * to point at paths.LOCAL_REPO. If CBG_DEV is set, symlinks to the dev
 * repo instead of cloning.
 *
 * Returns { ok: true, cacheDir, installOut } on success or
 * { ok: false, error, installOut } on failure.
 */
export function installAndSymlinkPlugin() {
    const REPO_URL = "https://github.com/jeff-hykin/claude_telegram_but_good.git"
    const localRepo = paths.LOCAL_REPO

    // Helper: remove localRepo if it exists. Missing-on-first-install
    // is the common case and shouldn't print anything.
    const quietRemoveLocalRepo = () => {
        try {
            Deno.removeSync(localRepo, { recursive: true })
        } catch (e) {
            if (!(e instanceof Deno.errors.NotFound)) {
                dbg("ONBOARD", "removeSync localRepo:", e)
            }
        }
    }

    const devPath = Deno.env.get("CBG_DEV")
    if (devPath) {
        quietRemoveLocalRepo()
        Deno.mkdirSync(join(localRepo, ".."), { recursive: true })
        Deno.symlinkSync(devPath, localRepo)
    } else {
        // First-time onboarding: paths.LOCAL_REPO doesn't exist yet,
        // so `statSync(.git)` throws NotFound. That's not an error
        // condition, it just means we skip the pull and go straight
        // to clone. Suppress the NotFound log; surface any other
        // stat failure (permission, broken symlink, ...).
        let shouldClone = true
        try {
            if (Deno.statSync(join(localRepo, ".git")).isDirectory) {
                new Deno.Command("git", {
                    args: ["-C", localRepo, "pull", "origin", "--ff-only"],
                    stdout: "null", stderr: "null",
                }).outputSync()
                shouldClone = false
            }
        } catch (e) {
            if (!(e instanceof Deno.errors.NotFound)) {
                dbg("ONBOARD", "existing repo check failed, re-cloning:", e)
            }
        }
        if (shouldClone) {
            quietRemoveLocalRepo()
            Deno.mkdirSync(join(localRepo, ".."), { recursive: true })
            new Deno.Command("git", {
                args: ["clone", "--depth", "1", REPO_URL, localRepo],
                stdout: "piped", stderr: "piped",
            }).outputSync()
        }
    }

    const claudeBin = findClaudeBinary()
    const realClaude = claudeBin?.realPath ?? "claude"

    const installResult = new Deno.Command(realClaude, {
        args: ["plugin", "install", PLUGIN_ID, "-s", "user"],
        stdout: "piped", stderr: "piped",
    }).outputSync()
    const installOut = new TextDecoder().decode(installResult.stdout).trim()
        || new TextDecoder().decode(installResult.stderr).trim()

    // Find the versioned cache dir (e.g. 0.0.4)
    let maxVer = ""
    try {
        for (const entry of Deno.readDirSync(paths.CLAUDE_PLUGIN_CACHE_DIR)) {
            if (entry.name > maxVer) { maxVer = entry.name }
        }
    } catch (e) {
        dbg("ONBOARD", "plugin cache readdir failed:", e)
    }

    if (!maxVer) {
        return { ok: false, error: "Could not find plugin cache directory after install", installOut }
    }

    const cacheDir = join(paths.CLAUDE_PLUGIN_CACHE_DIR, maxVer)
    const extDir = paths.CLAUDE_PLUGIN_EXTERNAL_DIR

    // Patch .mcp.json in both cache + external_plugins so live sessions
    // launched from either path find the local repo's mcp-server shim.
    const patchedMcp = buildPatchedMcpJson()
    for (const target of [cacheDir, extDir]) {
        const mcpPath = join(target, ".mcp.json")
        try {
            Deno.mkdirSync(target, { recursive: true })
        } catch (e) {
            dbg("ONBOARD", "mkdir target failed:", target, e)
        }
        Deno.writeTextFileSync(mcpPath, patchedMcp)
    }

    return { ok: true, cacheDir, installOut }
}

// ── Onboarding flow ───────────────────────────────────────────────────

/**
 * True once the essential prerequisites are all in place. Used by the
 * CLI to decide whether to auto-run `cbg onboard` before a subcommand.
 */
export function isOnboarded() {
    if (!isDtachInstalled()) {
        return false
    }
    if (!getBotToken()) {
        return false
    }
    try {
        const entries = Array.from(Deno.readDirSync(paths.CLAUDE_PLUGIN_CACHE_DIR))
        return entries.length > 0
    } catch (e) {
        dbg("ONBOARD", "plugin cache check failed:", e)
        return false
    }
}

/** If not onboarded, run the flow and re-check. Exit 1 on failure. */
export async function ensureOnboarded() {
    if (!isOnboarded()) {
        console.log("Need to finish onboarding first. Running cbg onboard...\n")
        await onboard()
        if (!isOnboarded()) {
            Deno.exit(1)
        }
    }
}

/**
 * Run the full onboarding flow: dtach, bot token, Claude CLI check,
 * plugin registration, permission mode, daemon start, Telegram pairing,
 * claude shim install, and a final verification pass.
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

    // --- Step 1b: git ---
    header("1b", "Git")
    const gitCheck = new Deno.Command("which", {
        args: ["git"],
        stdout: "piped",
        stderr: "null",
    }).outputSync()
    if (gitCheck.success) {
        ok("git is installed.")
    } else {
        fail("git not found on PATH.")
        info("Install it manually with one of:")
        info(c.white("  nix profile install nixpkgs#git"))
        info(c.white("  apt-get install git"))
        info(c.white("  brew install git"))
        info(c.white("  xcode-select --install"))
        Deno.exit(1)
    }

    // --- Step 2: Bot token ---
    header("2", "Telegram Bot Token")
    let token = getBotToken()
    if (token) {
        ok("Token already configured.")
        const keepToken = await Confirm.prompt({
            message: c.dim("  Use it?"),
            default: true,
        })
        if (!keepToken) {
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
        setBotToken(token)
        ok(`Token saved to ${paths.CONFIG_FILE}`)
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
        ok(pluginResult.installOut.replace(/\n/, "\n. "))
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

    setPermissionMode(permChoice)

    // Also write the raw flag(s) to a simple file the shell shim reads.
    Deno.mkdirSync(paths.STATE_DIR, { recursive: true })
    let permArgs = ""
    if (permChoice === "all") {
        permArgs = "--dangerously-skip-permissions"
    } else if (permChoice !== "default") {
        permArgs = `--permission-mode ${permChoice}`
    }
    Deno.writeTextFileSync(paths.PERMISSION_ARGS_FILE, permArgs)
    ok(`Permission mode: ${permChoice}`)

    // --- Step 6: Start service ---
    header("6", "Daemon Service")
    if (isDaemonRunning()) {
        warn("The cbg daemon is currently running.")
        warn("Continuing will stop it and break all existing shim connections")
        warn("(every Claude session attached to this daemon will lose its Telegram")
        warn("link until that session is restarted).")
        const proceed = await Confirm.prompt({
            message: c.dim("  Stop the running daemon and continue onboarding?"),
            default: false,
        })
        if (!proceed) {
            info("Aborted onboarding. The existing daemon is still running.")
            Deno.exit(0)
        }
        info("Stopping existing server...")
        try { stopService() } catch (e) { dbg("ONBOARD", "stopService:", e) }
    }
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

    const existingAllowFrom = readAccessAllowFrom()
    if (existingAllowFrom.length > 0) {
        ok(`Already paired (${existingAllowFrom.length} user(s) on allowlist).`)
        const keepPairing = await Confirm.prompt({
            message: c.dim("  Use that account?"),
            default: true,
        })
        if (keepPairing) {
            await doShimAndVerify(cacheDir)
            return
        }
    }

    // Generate a pairing OTP, stash it in the running daemon, and print
    // the pairing code. Shared helper — `cbg authorize` uses it too.
    // The /approve_user hot-command reads the OTP back through the
    // daemon's in-memory chatState.pendingOtps.
    info("Tip: the BotFather sent you a link to your bot, click it to open a DM.")
    await authorize()
    info("Waiting for pairing...")
    console.log()

    const beforeCount = existingAllowFrom.length
    while (true) {
        const current = readAccessAllowFrom()
        if (current.length > beforeCount) {
            break
        }
        await new Promise(r => setTimeout(r, 1500))
    }

    const final = readAccessAllowFrom()
    const newId = final[final.length - 1]
    ok(`Paired! User ${newId} added to allowlist.`)

    await doShimAndVerify(cacheDir)
}

async function doShimAndVerify(pluginDir) {
    // --- Step 8: Command Center (optional) ---
    header("8", "Command Center (optional)")
    info("A command center is a Telegram group with Topics enabled where")
    info("each Claude session gets its own topic thread.")
    console.log()

    let existingCcId = null
    try {
        const raw = Deno.readTextFileSync(paths.ACCESS_FILE)
        const access = JSON.parse(raw)
        existingCcId = access.commandCenterChatId ?? null
    } catch (e) {
        dbg("ONBOARD", "read commandCenterChatId:", e)
    }

    if (existingCcId) {
        ok(`Command center already configured (group ${existingCcId}).`)
        const keepCc = await Confirm.prompt({
            message: c.dim("  Use it?"),
            default: true,
        })
        if (!keepCc) {
            // Clear it
            try {
                const raw = Deno.readTextFileSync(paths.ACCESS_FILE)
                const access = JSON.parse(raw)
                delete access.commandCenterChatId
                if (access.groups?.[existingCcId]) {
                    delete access.groups[existingCcId]
                }
                const tmp = paths.ACCESS_FILE + ".tmp"
                Deno.writeTextFileSync(tmp, JSON.stringify(access, null, 2) + "\n")
                Deno.renameSync(tmp, paths.ACCESS_FILE)
                info("Command center cleared.")
            } catch (e) {
                dbg("ONBOARD", "clear commandCenterChatId:", e)
            }
            existingCcId = null
        }
    }

    if (!existingCcId) {
        const wantCc = await Confirm.prompt({
            message: c.dim("  Set up a command center group?"),
            default: true,
        })
        if (wantCc) {
            console.log()
            info("To set up a command center:")
            console.log()
            console.log("    1. Create a Telegram supergroup")
            console.log("    2. Enable " + c.white("Topics") + " in group settings")
            console.log("    3. Add your bot to the group")
            console.log("    4. Promote the bot to " + c.white("admin"))
            console.log("    5. Send " + c.cyan("/set_command_center") + " in the group")
            console.log()
            info("The bot will confirm once it's active.")
            info("You can do this now or later — it's optional.")
            console.log()

            const waitForIt = await Confirm.prompt({
                message: c.dim("  Wait for /set_command_center to be sent?"),
                default: true,
            })
            if (waitForIt) {
                info("Waiting for command center setup...")
                while (true) {
                    try {
                        const raw = Deno.readTextFileSync(paths.ACCESS_FILE)
                        const access = JSON.parse(raw)
                        if (access.commandCenterChatId) {
                            ok(`Command center activated (group ${access.commandCenterChatId}).`)
                            break
                        }
                    } catch (e) {
                        dbg("ONBOARD", "poll commandCenterChatId:", e)
                    }
                    await new Promise(r => setTimeout(r, 1500))
                }
            } else {
                info("Skipped. You can set it up later with /set_command_center in a group.")
            }
        } else {
            info("Skipped. You can set it up later with /set_command_center in a group.")
        }
    }

    // --- Step 9: Claude shim ---
    header("9", "Claude Shim")
    info("Wraps the claude command to auto-add Telegram + dtach.")
    const shimResult = installShim()
    if (shimResult.ok) {
        ok(shimResult.message)
    } else {
        fail(shimResult.message)
    }

    // --- Step 10: Verify ---
    header("10", "Verification")
    const checks = [
        { name: "dtach", ok: isDtachInstalled() },
        { name: "bot token", ok: !!getBotToken() },
        {
            name: "plugin",
            ok: (() => {
                try { Deno.statSync(pluginDir); return true } catch (e) { dbg("ONBOARD", "plugin check:", e); return false }
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

    console.log()
    if (allOk) {
        console.log(c.bold.green("  \u2714 Setup complete!"))
        console.log()
        console.log("    Run " + c.cyan("/list") + " on Telegram to connect to your Claude sessions.")
        console.log("    Tap a session to start messaging it.")
        info(c.dim("Note: only new claude terminals will be visible."))
        console.log()
        console.log(c.dim("  \u2500".repeat(45)))
        console.log(c.dim("  Tip: ") + c.white("claude --no-tele") + c.dim(" to hide a session from Telegram"))
        console.log(c.dim("       ") + c.white("cbg uninstall") + c.dim("    to remove everything"))
        console.log()
    } else {
        console.log(c.bold.yellow("  \u26A0 Some checks failed. Fix the issues above and re-run ") + c.white("cbg onboard"))
        console.log()
    }
}
