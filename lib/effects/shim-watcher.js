// ---------------------------------------------------------------------------
// lib/effects/shim-watcher.js — live file watcher for the claude CLI shim.
//
// The `cbg claude` shim at $PATH/claude gets silently clobbered whenever
// Claude Code auto-updates or the user runs `npm i -g @anthropic-ai/claude-code`.
// The periodic safety-net in lib/shim-health.js catches the clobber within
// a few minutes, but during that window every user `claude` invocation
// bypasses cbg entirely (the SurprisingRooster failure mode — session
// registers without dtach in its ancestry, /peek/pause/etc. stop working).
//
// This watcher closes the window. It opens Deno.watchFs() on the shim's
// actual path, debounces events to ~200 ms, and reinstalls the shim as
// soon as any modification is observed. If the watch-loop itself throws
// (platform quirk, fd exhaustion, file removed underneath us), we retry
// up to 3 times with a 5 s delay and then fall back to the periodic
// safety-net poller.
//
// Scope: this is a LONG-LIVED background task, not a handler-returned
// effect. main-server.js calls startShimWatcher(core) once at boot; the
// returned handle's .stop() can be used from shutdown paths (currently
// unused — the daemon exits via Deno.exit() which takes the watcher
// with it).
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"
import { dbg } from "../logging.js"
import { findClaudeBinary } from "../../event-generators/cli/shim-setup.js"

// isShimInstalled / installShim are resolved INSIDE checkAndHeal via
// versionedImport so a hot reload of shim-setup.js (e.g. because the
// install/marker logic changed) takes effect on the watcher's NEXT
// debounce fire — without having to restart the daemon. The top-level
// import of findClaudeBinary is fine as-is: it only runs once at
// startShimWatcher() time to resolve the path we're watching.

const DEBOUNCE_MS = 200
const RETRY_DELAY_MS = 5_000
const MAX_RETRIES = 3

/**
 * Start the shim file watcher. Returns a handle with a `.stop()` method.
 * Safe to call multiple times — each call starts a fresh watch loop, but
 * the ONE-instance-per-daemon invariant is enforced by main-server.js
 * calling this exactly once at boot.
 *
 * The function returns synchronously after kicking off the background
 * loop; callers do NOT need to await it.
 */
export function startShimWatcher(core, { overridePath } = {}) {
    let shimPath = overridePath
    if (!shimPath) {
        const info = findClaudeBinary()
        if (!info) {
            dbg("SHIM-WATCH", "no claude binary on PATH — file watcher disabled")
            return { stop: () => {}, enabled: false }
        }
        shimPath = info.claudePath
    }

    // On macOS, `/var/...` and `/private/var/...` are the same place but
    // FSEvents reports the resolved (`/private/var/...`) path while
    // Deno.makeTempDirSync returns the unresolved one. We resolve both
    // the path we hand to installShim/isShimInstalled and the path we
    // match events against so the two sides agree.
    let resolvedShimPath = shimPath
    try {
        resolvedShimPath = Deno.realPathSync(shimPath)
    } catch (e) {
        dbg("SHIM-WATCH", "realPathSync failed, using raw path:", e)
    }

    const watchDir = resolvedShimPath.slice(0, resolvedShimPath.lastIndexOf("/"))
    if (!watchDir) {
        dbg("SHIM-WATCH", `cannot determine parent dir of ${resolvedShimPath} — disabled`)
        return { stop: () => {}, enabled: false }
    }
    dbg("SHIM-WATCH", `watching dir=${watchDir} for changes to ${resolvedShimPath}`)

    const state = {
        stopped: false,
        retries: 0,
        currentWatcher: null,
    }

    runWatchLoop(resolvedShimPath, watchDir, state).catch((e) => {
        dbg("SHIM-WATCH", "top-level watch loop crashed:", e)
    })

    return {
        enabled: true,
        stop: () => {
            state.stopped = true
            try { state.currentWatcher?.close?.() } catch (e) { dbg("SHIM-WATCH", "close watcher on stop:", e) }
        },
    }
}

async function runWatchLoop(shimPath, watchDir, state) {
    while (!state.stopped) {
        let watcher
        try {
            // Watch the parent directory (not the file itself) so a
            // rename/unlink doesn't unhook our inotify/FSEvents handle.
            // We filter events by path so unrelated writes in the bin
            // dir are ignored cheaply.
            watcher = Deno.watchFs(watchDir, { recursive: false })
        } catch (e) {
            dbg("SHIM-WATCH", "watchFs failed to open:", e)
            if (!await backoff(state)) { return }
            continue
        }
        state.currentWatcher = watcher
        state.retries = 0

        let pending = false
        let debounceTimer = null

        const scheduleCheck = () => {
            if (pending) { return }
            pending = true
            debounceTimer = setTimeout(async () => {
                pending = false
                debounceTimer = null
                try {
                    await checkAndHeal(shimPath)
                } catch (e) {
                    dbg("SHIM-WATCH", "checkAndHeal threw:", e)
                }
            }, DEBOUNCE_MS)
        }

        try {
            for await (const ev of watcher) {
                if (state.stopped) { break }
                if (!ev || typeof ev.kind !== "string") { continue }
                if (!Array.isArray(ev.paths) || !ev.paths.includes(shimPath)) { continue }
                if (ev.kind === "modify" || ev.kind === "create" || ev.kind === "remove" || ev.kind === "rename") {
                    dbg("SHIM-WATCH", `event: ${ev.kind} on ${shimPath}`)
                    scheduleCheck()
                }
            }
        } catch (e) {
            dbg("SHIM-WATCH", "watcher iterator threw:", e)
        } finally {
            if (debounceTimer != null) { clearTimeout(debounceTimer) }
            try { watcher.close?.() } catch (e) { dbg("SHIM-WATCH", "watcher close:", e) }
            state.currentWatcher = null
        }

        if (state.stopped) { return }
        dbg("SHIM-WATCH", "watcher loop exited — will retry")
        if (!await backoff(state)) { return }
    }
}

async function backoff(state) {
    state.retries += 1
    if (state.retries > MAX_RETRIES) {
        dbg("SHIM-WATCH", `gave up after ${MAX_RETRIES} retries — safety-net poller (shim-health.js) is the fallback`)
        return false
    }
    dbg("SHIM-WATCH", `retry ${state.retries}/${MAX_RETRIES} in ${RETRY_DELAY_MS}ms`)
    await new Promise(r => setTimeout(r, RETRY_DELAY_MS))
    return !state.stopped
}

async function checkAndHeal(shimPath) {
    // Re-resolve isShimInstalled / installShim on every fire so a
    // hot-reloaded shim-setup.js (new SHIM_MARKER, new install logic,
    // etc.) takes effect without restarting the daemon. The import
    // resolves to Deno's module cache after the first call so this is
    // cheap, not a disk read.
    const shimSetup = await versionedImport(
        "../../event-generators/cli/shim-setup.js",
        import.meta,
    )
    if (shimSetup.isShimInstalled(shimPath)) {
        dbg("SHIM-WATCH", "shim still intact")
        return
    }
    dbg("SHIM-WATCH", "shim missing or clobbered — reinstalling")
    const result = shimSetup.installShim(shimPath)
    if (result.ok) {
        dbg("SHIM-WATCH", "reinstalled:", result.message)
    } else {
        dbg("SHIM-WATCH", "reinstall failed:", result.message)
    }
}
