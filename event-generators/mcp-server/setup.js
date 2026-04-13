// ---------------------------------------------------------------------------
// event-generators/mcp-server/setup.js
//
// Install/heal cbg's patched version of the upstream
// `telegram@claude-plugins-official` plugin's .mcp.json files.
//
// Claude Code caches that plugin in two locations under ~/.claude/plugins/:
//
//   - cache/claude-plugins-official/telegram/<version>/.mcp.json
//   - marketplaces/claude-plugins-official/external_plugins/telegram/.mcp.json
//
// The upstream .mcp.json launches upstream's shim. cbg needs them to
// launch the local `mcp-shim.js` sibling instead — that's what turns
// cbg into a transparent drop-in for the upstream plugin.
//
// Living in event-generators/mcp-server/ on purpose: anyone touching
// mcp-shim.js who wants to understand what Claude Code is told to
// launch, and who's responsible for keeping that fresh, finds both
// files in one directory. Parallel to:
//
//   - event-generators/hooks/setup.js     — install/uninstall cbg hooks
//   - event-generators/cli/shim-setup.js  — install/uninstall claude CLI shim
//
// TWO consumers, both intended:
//
//   1. CLI install-time — event-generators/cli/helpers.js's
//      installAndSymlinkPlugin() calls `buildPatchedMcpJson()` at
//      onboard / reinstall time to write the patched files fresh.
//
//   2. Runtime self-heal — mcp-shim.js calls
//      `ensureOfficialPluginPatched()` on every shim bootstrap.
//      When Claude Code caches a new upstream version, the new
//      versioned dir contains an UNPATCHED .mcp.json and on the next
//      `claude` launch Claude Code may pick it, silently reverting
//      to upstream behavior. This function repatches every known
//      .mcp.json — it's opportunistic (only runs when a patched
//      shim ran first) but clears drift as soon as any patched
//      version runs once after an upgrade.
// ---------------------------------------------------------------------------

import { versionedImport } from "../../lib/version.js"
import { join } from "../../imports.js"

const { dbg } = await versionedImport("../../lib/logging.js", import.meta)
const { paths } = await versionedImport("../../lib/paths.js", import.meta)

function expectedArg() {
    return `SESSION_CWD="$PWD" deno run -A "${paths.MCP_SHIM_JS}"`
}

export function buildPatchedMcpJson() {
    return JSON.stringify({
        mcpServers: {
            telegram: {
                command: "sh",
                args: ["-c", expectedArg()],
            },
        },
    }, null, 2) + "\n"
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
    const mcpPaths = []

    mcpPaths.push(join(paths.CLAUDE_PLUGIN_EXTERNAL_DIR, ".mcp.json"))

    try {
        for (const entry of Deno.readDirSync(paths.CLAUDE_PLUGIN_CACHE_DIR)) {
            if (entry.isDirectory) {
                mcpPaths.push(join(paths.CLAUDE_PLUGIN_CACHE_DIR, entry.name, ".mcp.json"))
            }
        }
    } catch (e) {
        dbg("PLUGIN-PATCH", "cache dir read failed:", String(e))
    }

    return mcpPaths
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
        } catch (e) {
            dbg("PLUGIN-PATCH", "parent missing, skipping:", mcpPath, String(e))
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
