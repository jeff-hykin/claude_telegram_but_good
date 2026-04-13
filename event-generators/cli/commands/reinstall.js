// ---------------------------------------------------------------------------
// `cbg reinstall` — refresh every install-time artifact AND hot-reload
// the running daemon in place.
//
// Steps, each idempotent (warn on failure, keep going):
//
//   1. Plugin + .mcp.json
//        installAndSymlinkPlugin() reinstalls the upstream
//        `telegram@claude-plugins-official` plugin via the Claude CLI and
//        overwrites its cached .mcp.json with one that launches our local
//        mcp-shim.js. Covers both the marketplace copy and every
//        versioned cache dir.
//
//   2. settings.json hooks + plugin enable
//        ensureSettingsJson() idempotently adds the PreToolUse /
//        PostToolUse / Stop hook entries and marks
//        `telegram@claude-plugins-official` as enabled. User-owned
//        entries in the same file are preserved.
//
//   3. Claude CLI shim
//        installShim() reinstalls the bash wrapper at $PATH/claude that
//        intercepts the user's `claude` command and adds --channels +
//        dtach.
//
//   4. Daemon
//        If the daemon is running, send it a `reload_cbg` IPC command.
//        That bumps `globalThis.cbgVersion`, rewrites `lib/version.js`
//        on disk, and broadcasts `version_bumped` to every connected
//        shim so every part of the running system picks up the new
//        code — without dropping a single shim connection or
//        restarting any Claude session.
//
//        If the daemon ISN'T running, start it fresh.
//
// Absorbs the former `cbg reload` (which didn't ship as a CLI subcommand
// but whose wire kind `reload_cbg` was plumbed through anyway). One
// command now covers "I changed code and want it live".
// ---------------------------------------------------------------------------

import { versionedImport } from "../../../lib/version.js"

const [
    { colors },
    { startService, isDaemonRunning },
    { paths },
    { dbg },
    { installShim },
    {
        installAndSymlinkPlugin,
        ensureSettingsJson,
        hotReloadDaemon,
    },
] = await Promise.all([
    versionedImport("../../../imports.js", import.meta),
    versionedImport("../../../lib/daemon.js", import.meta),
    versionedImport("../../../lib/paths.js", import.meta),
    versionedImport("../../../lib/logging.js", import.meta),
    versionedImport("../shim-setup.js", import.meta),
    versionedImport("../helpers.js", import.meta),
])
const c = colors

export async function runReinstall(_args) {
    console.log()
    console.log(c.bold.white("  Reinstalling cbg..."))
    console.log(c.dim("  " + "\u2500".repeat(40)))

    // ── Step 1: plugin + .mcp.json (the MCP shim path) ──────────────
    console.log(c.dim("  Reinstalling plugin + patching .mcp.json..."))
    const pluginResult = installAndSymlinkPlugin()
    if (pluginResult.ok) {
        console.log(c.green("  \u2714 Plugin reinstalled and .mcp.json patched."))
    } else {
        console.log(c.yellow("  \u26A0 ") + (pluginResult.error ?? "unknown plugin error"))
    }

    // ── Step 2: settings.json hooks + plugin enable ─────────────────
    console.log(c.dim("  Updating settings.json (hooks + plugin)..."))
    try {
        ensureSettingsJson()
        console.log(c.green("  \u2714 settings.json updated."))
    } catch (err) {
        console.log(c.yellow("  \u26A0 settings.json update failed: " + err))
    }

    // ── Step 3: claude CLI shim (the $PATH/claude bash wrapper) ─────
    console.log(c.dim("  Reinstalling claude CLI shim..."))
    const shimResult = installShim()
    if (shimResult.ok) {
        console.log(c.green("  \u2714 ") + shimResult.message)
    } else {
        console.log(c.yellow("  \u26A0 ") + shimResult.message)
    }

    // ── Step 4: daemon — hot-reload in place, or start if down ──────
    if (isDaemonRunning()) {
        console.log(c.dim("  Daemon is running — hot-reloading in place..."))
        try {
            const reply = await hotReloadDaemon()
            if (reply?.ok) {
                console.log(
                    c.green("  \u2714 Hot reload complete — daemon now at cbgVersion ")
                    + c.white(String(reply.version)) + c.green("."),
                )
                console.log(c.dim("    Connected shims pick up new code on their next tool call."))
            } else {
                console.log(c.yellow("  \u26A0 Hot reload returned: " + JSON.stringify(reply)))
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            console.log(c.yellow("  \u26A0 Hot reload failed: " + msg))
            console.log(c.dim("    Run `cbg restart` to apply disk changes via a hard restart."))
        }
    } else {
        console.log(c.dim("  Daemon not running — starting it..."))
        try { Deno.removeSync(paths.STOPPED_FILE) } catch (e) { dbg("REINSTALL", "remove STOPPED_FILE:", e) }
        const out = startService()
        if (out.trim()) {
            console.log(c.dim("  " + out.trim()))
        }
        console.log(c.green("  \u2714 Daemon started."))
    }

    console.log()
    console.log(c.green("  \u2714 Reinstall complete."))
    console.log()
}
