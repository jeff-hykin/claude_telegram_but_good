// ---------------------------------------------------------------------------
// event-generators/hooks/install.js
//
// Register / unregister cbg's Claude Code hook entries inside a
// settings.json document. These functions are PURE with respect to the
// filesystem — they mutate the given `settings` object in place and
// return nothing. Disk I/O is the caller's responsibility.
//
// Living next to hook.js + run-hook on purpose: if you ever change what
// events the hook subscribes to, or the shape of the entries cbg writes,
// the install/uninstall pair should change in lockstep with the runtime
// script in this directory.
// ---------------------------------------------------------------------------

import { versionedImport } from "../../lib/version.js"

const { paths } = await versionedImport("../../lib/paths.js", import.meta)

// The set of Claude Code hook events cbg subscribes to. Adding a new
// event here (and teaching hook.js to handle it) is all it takes to
// extend coverage — ensureSettingsJson / removeFromSettingsJson on the
// caller side automatically pick it up.
export const HOOK_EVENTS = ["PreToolUse", "PostToolUse", "Stop"]

function hookEntry() {
    return {
        type: "command",
        command: paths.HOOK_PATH,
        timeout: 5,
    }
}

/**
 * Mutate `settings` so every entry in HOOK_EVENTS has a matcher="*"
 * entry pointing at paths.HOOK_PATH. Idempotent. Rewrites any stale
 * cbg hook paths from previous installs (e.g. if CBG_DIR moved).
 */
export function installHooks(settings) {
    if (!settings.hooks) {
        settings.hooks = {}
    }
    for (const event of HOOK_EVENTS) {
        if (!settings.hooks[event]) {
            settings.hooks[event] = []
        }
        // Rewrite any stale hook paths from previous installs.
        for (const matcher of settings.hooks[event]) {
            for (const h of (matcher.hooks ?? [])) {
                if (h.command && h.command !== paths.HOOK_PATH && h.command.includes("hook")) {
                    h.command = paths.HOOK_PATH
                }
            }
        }
        const found = settings.hooks[event].find(m =>
            m.matcher === "*" && m.hooks?.some(h => h.command === paths.HOOK_PATH)
        )
        if (!found) {
            settings.hooks[event].push({ matcher: "*", hooks: [hookEntry()] })
        }
    }
}

/**
 * Mutate `settings` to remove any cbg-owned hook entries. Matches
 * either the current paths.HOOK_PATH or any legacy path containing
 * "cbg" (so stale entries from older installs get cleaned up too).
 */
export function uninstallHooks(settings) {
    for (const event of HOOK_EVENTS) {
        if (Array.isArray(settings.hooks?.[event])) {
            settings.hooks[event] = settings.hooks[event].filter(
                m => !m.hooks?.some(h => h.command === paths.HOOK_PATH || h.command?.includes("cbg"))
            )
        }
    }
}
