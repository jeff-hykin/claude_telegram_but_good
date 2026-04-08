/**
 * Claude CLI shim: renames the real `claude` binary to `_claude_before_cbg`
 * and installs a wrapper that adds --channels and dtach wrapping.
 *
 * The wrapper:
 *  - If --no-tele is the first arg: strips it, calls _claude_before_cbg directly
 *  - If args are a known subcommand or non-interactive flag: passes through directly
 *  - Otherwise: adds --channels, wraps in dtach (if available), sets CBG_* env vars
 */

import { join } from "../imports.js"
import { STATE_DIR } from "./protocol.js"
import { shellNameGenerator } from "./names.js"

const SHIM_MARKER = "# __CBG_SHIM__"

/**
 * Find the directory and full path of the real claude binary.
 * Skips any existing cbg shim to avoid double-shimming.
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

    // Check if this is already our shim
    try {
        const content = Deno.readTextFileSync(claudePath)
        if (content.includes(SHIM_MARKER)) {
            // It's our shim — the real binary is _claude_before_cbg in the same dir
            const dir = claudePath.slice(0, claudePath.lastIndexOf("/"))
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

    return { dir: claudePath.slice(0, claudePath.lastIndexOf("/")), claudePath, realPath: claudePath, alreadyShimmed: false }
}

function shimScript(stateDir) {
    const nameGen = shellNameGenerator()
    return `#!/usr/bin/env sh
${SHIM_MARKER}
# Installed by cbg (claude_telegram_but_good)
# Wraps claude with telegram channels + dtach session management.
# To remove: cbg uninstall

REAL="$(dirname "$0")/_claude_before_cbg"

# --no-tele as the first arg: strip it and pass through directly
if [ "$1" = "--no-tele" ]; then
    shift
    exec "$REAL" "$@"
fi

# Detect passthrough cases: subcommands, non-interactive flags
# These get no --channels and no dtach
PASSTHROUGH=0
case "$1" in
    # Known subcommands (non-interactive)
    agents|auth|auto-mode|doctor|install|mcp|plugin|plugins|setup-token|update|upgrade)
        PASSTHROUGH=1 ;;
esac

# Check for non-interactive flags anywhere in args
for arg in "$@"; do
    case "$arg" in
        -p|--print|-v|--version|-h|--help)
            PASSTHROUGH=1 ;;
    esac
done

if [ "$PASSTHROUGH" = "1" ]; then
    exec "$REAL" "$@"
fi

# Interactive mode: add --channels (if not already present), wrap in dtach if available
HAS_CHANNELS=0
for arg in "$@"; do
    case "$arg" in
        --channels) HAS_CHANNELS=1 ;;
    esac
done

EXTRA_ARGS=""
if [ "$HAS_CHANNELS" = "0" ]; then
    EXTRA_ARGS="--channels plugin:telegram@claude-plugins-official"
fi

if command -v dtach >/dev/null 2>&1; then
    # Generate human-friendly session name
    ${nameGen}
    SOCK="${stateDir}/dtach-\${SESSION_ID}.sock"

    mkdir -p "${stateDir}"
    printf '{"id":"%s","dtachSocket":"%s"}\\n' "$SESSION_ID" "$SOCK" \\
        > "${stateDir}/next_session.json"

    export CBG_DTACH=1
    export CBG_DTACH_SOCKET="$SOCK"
    export CBG_SESSION_ID="$SESSION_ID"

    exec dtach -c "$SOCK" -z "$REAL" $EXTRA_ARGS "$@"
else
    # No dtach — still add channels but run directly
    exec "$REAL" $EXTRA_ARGS "$@"
fi
`
}

/**
 * Install the claude shim.
 * Returns { ok, message }.
 */
export function installShim() {
    const info = findClaudeBinary()
    if (!info) {
        return { ok: false, message: "Could not find claude binary on PATH" }
    }

    const { dir, claudePath, realPath, alreadyShimmed } = info

    if (alreadyShimmed) {
        // Re-install: overwrite the shim in place, _claude_before_cbg is already correct
        try {
            Deno.writeTextFileSync(claudePath, shimScript(STATE_DIR))
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
        Deno.writeTextFileSync(claudePath, shimScript(STATE_DIR))
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
 * Check if the shim is currently installed.
 */
export function isShimInstalled() {
    const info = findClaudeBinary()
    return info?.alreadyShimmed ?? false
}
