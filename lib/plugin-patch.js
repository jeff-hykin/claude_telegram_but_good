/**
 * Ensures the official `telegram@claude-plugins-official` plugin's .mcp.json
 * files point at the local cbg shim.
 *
 * Claude Code installs the upstream plugin into two places:
 *   - ~/.claude/plugins/cache/claude-plugins-official/telegram/<version>/.mcp.json
 *   - ~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/telegram/.mcp.json
 *
 * Onboarding patches both so they launch our shim. But when the upstream
 * plugin updates, a new versioned cache dir appears with the unpatched
 * upstream config — silently reverting to upstream behavior on next launch.
 *
 * `ensureOfficialPluginPatched()` is called from shim.js on every startup so
 * drift is self-healed as soon as any cbg-patched shim runs once.
 */

import { join } from "../imports.js"
import { HOME, LOCAL_REPO, dbg } from "./protocol.js"

export function buildPatchedMcpJson() {
    return JSON.stringify({
        mcpServers: {
            telegram: {
                command: "sh",
                args: ["-c", `SESSION_CWD="$PWD" deno run -A "${LOCAL_REPO}/shim.js"`],
            },
        },
    }, null, 2) + "\n"
}

function expectedArg() {
    return `SESSION_CWD="$PWD" deno run -A "${LOCAL_REPO}/shim.js"`
}

export function isMcpPatched(mcpPath) {
    try {
        const parsed = JSON.parse(Deno.readTextFileSync(mcpPath))
        const args = parsed?.mcpServers?.telegram?.args
        if (!Array.isArray(args)) {
            return false
        }
        return args.includes(expectedArg())
    } catch (e) {
        dbg("PLUGIN-PATCH", "read/parse failed:", mcpPath, String(e))
        return false
    }
}

function writePatched(mcpPath) {
    try {
        Deno.mkdirSync(join(mcpPath, ".."), { recursive: true })
        Deno.writeTextFileSync(mcpPath, buildPatchedMcpJson())
        return true
    } catch (e) {
        dbg("PLUGIN-PATCH", "write failed:", mcpPath, String(e))
        return false
    }
}

/**
 * Collect the .mcp.json paths we need to keep patched:
 *   - the marketplace external_plugins copy
 *   - every versioned dir under the cache (covers the current version plus
 *     any stale ones Claude might fall back to)
 */
export function collectOfficialMcpPaths() {
    const paths = []

    paths.push(join(
        HOME, ".claude", "plugins", "marketplaces",
        "claude-plugins-official", "external_plugins", "telegram", ".mcp.json",
    ))

    const cacheBase = join(
        HOME, ".claude", "plugins", "cache",
        "claude-plugins-official", "telegram",
    )
    try {
        for (const entry of Deno.readDirSync(cacheBase)) {
            if (entry.isDirectory) {
                paths.push(join(cacheBase, entry.name, ".mcp.json"))
            }
        }
    } catch (e) {
        dbg("PLUGIN-PATCH", "cache dir read failed:", String(e))
    }

    return paths
}

/**
 * Verify every known official-plugin .mcp.json points at the local shim.
 * Rewrites any that drifted (e.g. a new upstream version was just cached).
 * Returns { checked, patched } — arrays of absolute file paths.
 */
export function ensureOfficialPluginPatched() {
    const checked = []
    const patched = []

    for (const mcpPath of collectOfficialMcpPaths()) {
        // Skip paths whose parent dir doesn't exist — that version isn't
        // installed, no need to create phantom files.
        try {
            Deno.statSync(join(mcpPath, ".."))
        } catch {
            continue
        }

        checked.push(mcpPath)
        if (isMcpPatched(mcpPath)) {
            continue
        }
        dbg("PLUGIN-PATCH", "drift detected, repatching:", mcpPath)
        if (writePatched(mcpPath)) {
            patched.push(mcpPath)
        }
    }

    if (patched.length > 0) {
        dbg("PLUGIN-PATCH", `repatched ${patched.length} file(s)`)
    }
    return { checked, patched }
}
