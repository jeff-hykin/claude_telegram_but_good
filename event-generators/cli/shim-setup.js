/**
 * event-generators/cli/shim-setup.js
 *
 * Install/uninstall/inspect the CLAUDE BINARY shim — a bash wrapper
 * dropped at $PATH/claude that renames the real binary to
 * `_claude_before_cbg` and wraps every interactive invocation with
 * --channels + dtach so it registers with cbg.
 *
 * NOTE: this is the *claude CLI* shim, NOT the MCP server shim. The MCP
 * shim lives at event-generators/mcp-server/mcp-shim.js and is an
 * entirely separate concern — it's loaded by Claude Code as an MCP
 * server. This file owns the install-time bash wrapper that intercepts
 * the user's `claude` command to add cbg's flags.
 *
 * CLI-only: helpers.js and the reinstall/uninstall commands are the only
 * callers. No daemon or event-handler consumers.
 *
 * The wrapper script's behavior:
 *  - If --no-tele is the first arg: strips it, calls _claude_before_cbg directly
 *  - If args are a known subcommand or non-interactive flag: passes through directly
 *  - Otherwise: adds --channels, wraps in dtach (if available), sets CBG_* env vars
 */

import { join } from "../../imports.js"

const SHIM_MARKER = "# __CBG_SHIM__"

/**
 * Build an info object for a specific `claude` path on disk. Split out
 * from findClaudeBinary() so tests and the live file watcher can target
 * a specific file without relying on `which claude`.
 *
 * Returns null if the path doesn't exist or the shim is present but its
 * `_claude_before_cbg` sibling is missing (ambiguous state — we'd rather
 * bail than overwrite).
 */
export function inspectShimPath(claudePath) {
    if (typeof claudePath !== "string" || claudePath.length === 0) {
        return null
    }
    try {
        Deno.statSync(claudePath)
    } catch {
        return null
    }

    const dir = claudePath.slice(0, claudePath.lastIndexOf("/"))

    try {
        const content = Deno.readTextFileSync(claudePath)
        if (content.includes(SHIM_MARKER)) {
            const realPath = join(dir, "_claude_before_cbg")
            try {
                Deno.statSync(realPath)
                return { dir, claudePath, realPath, alreadyShimmed: true }
            } catch {
                return null
            }
        }
    } catch {
        // Binary file, not text — that's fine, it's the real claude
    }

    return { dir, claudePath, realPath: claudePath, alreadyShimmed: false }
}

/**
 * Find the directory and full path of the real claude binary via
 * `which claude`. Skips any existing cbg shim (by reading the file and
 * looking for SHIM_MARKER) to avoid double-shimming.
 */
export function findClaudeBinary() {
    const result = new Deno.Command("which", {
        args: ["claude"],
        stdout: "piped",
        stderr: "null",
    }).outputSync()
    if (!result.success) {
        return null
    }
    const claudePath = new TextDecoder().decode(result.stdout).trim()
    if (!claudePath) {
        return null
    }
    return inspectShimPath(claudePath)
}

// The shim used to be ~80 lines of POSIX sh that duplicated paths from
// lib/paths.js (STATE_DIR, PERMISSION_ARGS_FILE, NEXT_SESSION_FILE,
// dtachSockFile, dtachLogFile). All of that logic now lives in JS at
// event-generators/cli/commands/claude.js (dispatched by cli.js as
// `cbg claude`), so the shim collapses to a ~3-line delegator that
// checks for deno + cbg on PATH and exec's `cbg claude "$@"`. Both
// fallbacks land on `_claude_before_cbg` so a broken cbg/deno install
// never bricks the user's `claude` command.
function shimScript() {
    return `#!/usr/bin/env sh
${SHIM_MARKER}
# Installed by cbg (claude_telegram_but_good)
# Delegates to \`cbg claude\`, which reads paths from lib/paths.js
# and handles --no-tele / passthrough detection / dtach wrapping in JS.
# To remove: cbg uninstall
if ! command -v deno >/dev/null 2>&1; then
    echo "cbg claude shim: 'deno' not on PATH. Install: https://deno.land/" >&2
    exec "$(dirname "$0")/_claude_before_cbg" "$@"
fi
if ! command -v cbg >/dev/null 2>&1; then
    echo "cbg claude shim: 'cbg' not on PATH — falling back to raw claude" >&2
    exec "$(dirname "$0")/_claude_before_cbg" "$@"
fi
exec cbg claude "$@"
`
}

/**
 * Install the claude shim. Optional `targetPath` lets the live file
 * watcher and unit tests reinstall at a specific path instead of
 * rediscovering via `which claude` — useful when the watcher already
 * knows which file it's guarding.
 *
 * Returns { ok, message }.
 */
export function installShim(targetPath) {
    const info = targetPath ? inspectShimPath(targetPath) : findClaudeBinary()
    if (!info) {
        return { ok: false, message: targetPath
            ? `Could not inspect claude shim at ${targetPath}`
            : "Could not find claude binary on PATH" }
    }

    const { dir, claudePath, realPath, alreadyShimmed } = info

    if (alreadyShimmed) {
        // Re-install: overwrite the shim in place, _claude_before_cbg is already correct
        try {
            Deno.writeTextFileSync(claudePath, shimScript())
            Deno.chmodSync(claudePath, 0o755)
            return { ok: true, message: `Shim updated at ${claudePath} (was already installed)` }
        } catch (err) {
            return { ok: false, message: `Failed to update shim: ${err}` }
        }
    }

    // Fresh install: rename claude -> _claude_before_cbg, write shim as claude
    const backupPath = join(dir, "_claude_before_cbg")

    // If _claude_before_cbg already exists but claude isn't our shim, something is weird.
    // Overwrite it — the user is re-installing.
    try {
        Deno.renameSync(claudePath, backupPath)
    } catch (err) {
        return { ok: false, message: `Failed to rename ${claudePath} -> ${backupPath}: ${err}` }
    }

    try {
        Deno.writeTextFileSync(claudePath, shimScript())
        Deno.chmodSync(claudePath, 0o755)
    } catch (err) {
        // Roll back
        try { Deno.renameSync(backupPath, claudePath) } catch { /* best effort */ }
        return { ok: false, message: `Failed to write shim: ${err}` }
    }

    return { ok: true, message: `Shim installed: ${claudePath} (original at ${backupPath})` }
}

/**
 * Remove the claude shim, restoring the original binary.
 * Returns { ok, message }.
 */
export function removeShim() {
    const info = findClaudeBinary()
    if (!info) {
        return { ok: false, message: "Could not find claude binary on PATH" }
    }

    if (!info.alreadyShimmed) {
        return { ok: true, message: "No cbg shim installed — claude is already the original binary" }
    }

    const { claudePath, realPath } = info

    try {
        Deno.removeSync(claudePath)
        Deno.renameSync(realPath, claudePath)
        return { ok: true, message: `Shim removed, original restored at ${claudePath}` }
    } catch (err) {
        return { ok: false, message: `Failed to restore original: ${err}` }
    }
}

/**
 * Check if the shim is currently installed. Optional `targetPath` skips
 * the `which claude` call — useful for tests and for the live file
 * watcher, which already knows which path it's guarding.
 */
export function isShimInstalled(targetPath) {
    const info = targetPath ? inspectShimPath(targetPath) : findClaudeBinary()
    return info?.alreadyShimmed ?? false
}
