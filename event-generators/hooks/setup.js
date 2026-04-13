// ---------------------------------------------------------------------------
// event-generators/hooks/setup.js
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
 * True if this hook command is one cbg owns. Used by both installHooks
 * (to rewrite a stale cbg path after a relocation) and uninstallHooks
 * (to know which entries to remove). Keep the two sides symmetric.
 *
 * Precision matters: a false positive here means we clobber a user's
 * unrelated hook. We match:
 *   - the exact current paths.HOOK_PATH (trivially cbg's)
 *   - any command ending in "/event-generators/hooks/run-hook"
 *     (cbg's wrapper, possibly at a stale repo location after CBG_DIR moved)
 *
 * We do NOT match on "hook" as a substring — a user-hook at
 * /usr/local/bin/pre-hook or similar should NOT be rewritten.
 */
function isCbgHookCommand(cmd) {
    if (typeof cmd !== "string" || cmd.length === 0) {
        return false
    }
    if (cmd === paths.HOOK_PATH) {
        return true
    }
    if (cmd.endsWith("/event-generators/hooks/run-hook")) {
        return true
    }
    return false
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
        // Rewrite any stale cbg hook paths from previous installs —
        // but NEVER touch a user's own hook that happens to have "hook"
        // in its path. `isCbgHookCommand` is deliberately narrow.
        for (const matcher of settings.hooks[event]) {
            for (const h of (matcher.hooks ?? [])) {
                if (isCbgHookCommand(h.command) && h.command !== paths.HOOK_PATH) {
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
 * Mutate `settings` to remove any cbg-owned hook entries. Uses the
 * same `isCbgHookCommand` predicate as installHooks so install and
 * uninstall can't drift. A matcher entry is removed if ANY of its
 * hooks is cbg-owned — this is correct because installHooks only
 * ever creates matcher entries whose `hooks` array contains a single
 * cbg hook, so there's no cross-contamination with user hooks.
 */
export function uninstallHooks(settings) {
    for (const event of HOOK_EVENTS) {
        if (Array.isArray(settings.hooks?.[event])) {
            settings.hooks[event] = settings.hooks[event].filter(
                m => !m.hooks?.some(h => isCbgHookCommand(h.command)),
            )
        }
    }
}
