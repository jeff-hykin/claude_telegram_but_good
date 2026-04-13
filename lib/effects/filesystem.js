/**
 * Filesystem side effects.
 *
 * Exposes effect implementations for writing files and bumping the cbg
 * version. Keeping these in a separate module means handlers stay pure
 * (they describe intent; tooling does the work).
 */

import { versionedImport } from "../version.js"
import { sibling } from "../../imports.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { encodeIpcFrame } = await versionedImport("../ipc.js", import.meta)

/**
 * Atomic-ish file write.
 *
 * effect shape: { type: "write_file", path: "...", content: "..." }
 */
export function writeFile(effect, _core) {
    const { path, content } = effect
    if (!path || typeof path !== "string") {
        dbg("FS", "write_file: missing or invalid path")
        return
    }
    try {
        // Ensure parent directory exists
        const parent = path.substring(0, path.lastIndexOf("/"))
        if (parent) {
            Deno.mkdirSync(parent, { recursive: true })
        }
        Deno.writeTextFileSync(path, content ?? "")
        dbg("FS", `wrote ${path} (${(content ?? "").length} chars)`)
    } catch (e) {
        dbg("FS", `write_file failed for ${path}:`, e)
    }
}

/**
 * Atomic(-ish) file move via rename. Creates the destination's parent
 * directory if needed. Missing source is not an error — move effects
 * should be idempotent the same way delete effects are, since handlers
 * may re-emit a terminal transition and the file could already be in
 * its destination from a prior run.
 *
 * Callers should NOT rely on this for cross-filesystem moves. Deno's
 * `renameSync` is atomic only on the same filesystem; a cross-mount
 * rename would throw EXDEV. Since all cbg file moves happen inside
 * `$CBG_DIR/long-tasks/<taskId>/`, that's a non-issue for current
 * callers — but document it here in case a future caller reaches out.
 *
 * effect shape: { type: "move_file", from: "...", to: "..." }
 */
export function moveFile(effect, _core) {
    const { from, to } = effect
    if (!from || typeof from !== "string" || !to || typeof to !== "string") {
        dbg("FS", "move_file: missing or invalid from/to")
        return
    }
    try {
        const parent = to.substring(0, to.lastIndexOf("/"))
        if (parent) {
            Deno.mkdirSync(parent, { recursive: true })
        }
        Deno.renameSync(from, to)
        dbg("FS", `moved ${from} -> ${to}`)
    } catch (e) {
        if (e instanceof Deno.errors.NotFound) {
            // Source already gone — fine, idempotent.
            return
        }
        dbg("FS", `move_file failed ${from} -> ${to}:`, e)
    }
}

/**
 * Best-effort file deletion. Missing file is not an error — cleanup
 * effects should be idempotent since a handler might re-emit the same
 * terminal transition (e.g. after a restart) and the file may already
 * be gone.
 *
 * effect shape: { type: "delete_file", path: "..." }
 */
/**
 * Recursive mkdir. Idempotent: silently no-ops if the directory
 * already exists.
 *
 * effect shape: { type: "mkdir", path: "..." }
 */
export function mkdir(effect, _core) {
    const { path } = effect
    if (!path || typeof path !== "string") {
        dbg("FS", "mkdir: missing or invalid path")
        return
    }
    try {
        Deno.mkdirSync(path, { recursive: true })
        dbg("FS", `mkdir ${path}`)
    } catch (e) {
        dbg("FS", `mkdir failed for ${path}:`, e)
    }
}

export function deleteFile(effect, _core) {
    const { path } = effect
    if (!path || typeof path !== "string") {
        dbg("FS", "delete_file: missing or invalid path")
        return
    }
    try {
        Deno.removeSync(path)
        dbg("FS", `deleted ${path}`)
    } catch (e) {
        if (e instanceof Deno.errors.NotFound) {
            // Already gone — fine.
            return
        }
        dbg("FS", `delete_file failed for ${path}:`, e)
    }
}

/**
 * Bump the cbg hot-reload version.
 *
 * 1. Updates `globalThis.cbgVersion` in-process (server-side).
 * 2. Rewrites `lib/version.js` on disk so the new VERSION is persisted.
 *    The version.js file IS the version file — there is no separate
 *    cbg.version anywhere.
 * 3. Broadcasts `{ type: "version_bumped", version }` to every live shim
 *    connection in `core.chatSessions` so each shim updates its own
 *    `globalThis.cbgVersion`. The next `versionedImport(...)` inside
 *    those shims produces a fresh module URL, which Deno treats as a
 *    cache miss — so the shim's reloadable graph rolls forward without
 *    restarting the session.
 *
 * Subsequent processes (restarted daemons, brand-new shims, hooks) that
 * import version.js will read the updated VERSION constant at load time
 * and initialize globalThis.cbgVersion from it.
 *
 * effect shape: { type: "bump_cbg_version", toVersion: 7 }
 * If toVersion is not provided, increments by 1.
 */
export async function bumpCbgVersion(effect, core) {
    const current = globalThis.cbgVersion ?? 1
    const target = typeof effect.toVersion === "number" ? effect.toVersion : current + 1
    globalThis.cbgVersion = target

    // Locate version.js relative to THIS file (effects/filesystem.js).
    // sibling(import.meta, "../version.js") → <lib-dir>/version.js
    const versionJsPath = sibling(import.meta, "../version.js")
    try {
        const source = Deno.readTextFileSync(versionJsPath)
        const updated = source.replace(
            /export const VERSION = \d+/,
            `export const VERSION = ${target}`,
        )
        if (updated === source) {
            dbg("FS", `bump_cbg_version: no VERSION constant found to rewrite in ${versionJsPath}`)
        } else {
            Deno.writeTextFileSync(versionJsPath, updated)
            dbg("FS", `bumped cbgVersion ${current} -> ${target}, rewrote ${versionJsPath}`)
        }
    } catch (e) {
        dbg("FS", "bump_cbg_version: failed to rewrite version.js:", e)
    }

    // Broadcast first (sync) so shims start re-importing ASAP.
    broadcastVersionToShims(core, target)

    // Re-initialize module-level state on the new version's instances of
    // any reloadable modules that hold mutable state. Each of these is a
    // fresh Map/null/whatever after the version bump (Deno's module cache
    // keys by URL, and versionedImport salts URLs with cbgVersion), so
    // without these re-inits, post-bump events see empty state.
    //
    // Pattern: `versionedImport` uses the NEW globalThis.cbgVersion we
    // just set, so each import lands on the instance future events will
    // actually observe.

    // hot-commands.js — registry Map is empty on fresh instance. Without
    // this, every /command returns "Unknown command" after a version bump.
    try {
        const hotCommandsMod = await versionedImport("../hot-commands.js", import.meta)
        if (core?.commandsDir && typeof hotCommandsMod.loadCommands === "function") {
            const { loaded, errors } = await hotCommandsMod.loadCommands(core.commandsDir)
            dbg("FS", `bump_cbg_version: repopulated hot commands at v=${target}: ${loaded} loaded, ${errors.length} errors`)
        } else {
            dbg("FS", `bump_cbg_version: skipped hot-command reload (commandsDir=${core?.commandsDir}, loadCommands=${typeof hotCommandsMod.loadCommands})`)
        }
    } catch (e) {
        dbg("FS", "bump_cbg_version: hot-command reload failed:", e)
    }

    // persistence.js — coreRef is null on a fresh instance, so every
    // schedulePersist() call would silently drop with "no core ref,
    // cannot flush". Since main-event-processor.js re-imports
    // persistence at the new version on every event, without this
    // re-init NO state would get persisted after the first version bump.
    try {
        const persistenceMod = await versionedImport("./persistence.js", import.meta)
        if (typeof persistenceMod.setCoreRef === "function") {
            persistenceMod.setCoreRef(core)
            dbg("FS", `bump_cbg_version: re-set persistence coreRef at v=${target}`)
        }
    } catch (e) {
        dbg("FS", "bump_cbg_version: persistence re-init failed:", e)
    }
}

/**
 * Send a `version_bumped` IPC message to every registered shim
 * connection so each one can update its in-memory `globalThis.cbgVersion`
 * without having to restart. Any failure is logged and swallowed — a
 * dead connection simply means that shim's session is gone and we'd
 * pick up the new version on its next boot anyway.
 *
 * Exported for tests.
 */
export function broadcastVersionToShims(core, version) {
    const sessions = core?.chatSessions ?? {}
    let delivered = 0
    // Stays SYNC (no await) so tests and the callers that don't care
    // about the Promise can keep calling this as a fire-and-forget.
    // A sync-throwing write (seen in the dead-conn test) bubbles to the
    // try/catch; an async rejection still becomes unhandled, matching
    // the pre-existing behavior of the old sendIpc helper.
    for (const [sid, sess] of Object.entries(sessions)) {
        const conn = sess?._conn
        if (!conn) { continue }
        try {
            conn.write(encodeIpcFrame({ type: "version_bumped", version }))
            delivered += 1
        } catch (e) {
            dbg("FS", `broadcast version_bumped to ${sid} failed:`, e)
        }
    }
    dbg("FS", `broadcast version_bumped (v=${version}) to ${delivered} shim(s)`)
}
