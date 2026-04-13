// ---------------------------------------------------------------------------
// lib/shim-health.js — safety-net self-heal for the claude CLI shim.
//
// The cbg claude shim at $PATH/claude gets clobbered when the user runs
// `npm i -g @anthropic-ai/claude-code` or when Claude Code auto-updates:
// the package manager rewrites the symlink to point directly at the real
// cli.js, silently erasing the bash wrapper cbg installed. After that
// happens, `--no-tele` stops working and every code path that assumes
// the shim (commands/new.js, commands/doctor.js, etc.) quietly breaks.
//
// The PRIMARY healing mechanism is now the live file watcher in
// lib/effects/shim-watcher.js, which reacts to filesystem events within
// ~200 ms. This module is the SAFETY NET: `onEvent` calls
// `maybeHealShim()` at the top of every event dispatch, throttled to
// one `which claude` + file-read per 5 minutes. If the watcher is up
// this check will reliably find the shim intact and no-op; if the
// watcher crashed, died, or couldn't open on this platform, we still
// catch the clobber within 5 min worst-case.
//
// The throttle timestamp lives on `globalThis` (not module-scope) so a
// `versionedImport`-driven hot reload doesn't reset it and cause a
// storm of checks on the first event after every reload.
// ---------------------------------------------------------------------------

import { versionedImport } from "./version.js"
const { dbg } = await versionedImport("./logging.js", import.meta)
const { isShimInstalled, installShim } = await versionedImport(
    "../event-generators/cli/shim-setup.js",
    import.meta,
)

const THROTTLE_MS = 5 * 60 * 1000
const LAST_CHECK_KEY = "__cbgShimHealLastCheckAt"

export function maybeHealShim() {
    const now = Date.now()
    const lastCheckAt = globalThis[LAST_CHECK_KEY] ?? 0
    if (now - lastCheckAt < THROTTLE_MS) { return }
    globalThis[LAST_CHECK_KEY] = now

    try {
        if (isShimInstalled()) {
            dbg("SHIM_HEAL", "safety-net check: shim intact")
            return
        }
        dbg("SHIM_HEAL", "safety-net check: claude shim missing — reinstalling (watcher may have missed it)")
        const result = installShim()
        if (result.ok) {
            dbg("SHIM_HEAL", "reinstalled:", result.message)
        } else {
            dbg("SHIM_HEAL", "reinstall failed:", result.message)
        }
    } catch (e) {
        dbg("SHIM_HEAL", "health check threw:", e)
    }
}
