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
export function bumpCbgVersion(effect, core) {
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

    broadcastVersionToShims(core, target)
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
