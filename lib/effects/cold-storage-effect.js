/**
 * Thin translator from a `cold_append` effect to lib/cold-storage.js.
 *
 * Handlers describe cold writes as effects so the handler layer stays
 * pure (no direct disk I/O). This module executes those writes.
 */

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { appendColdEntry } = await versionedImport("../cold-storage.js", import.meta)
const { getHooksArchiveEnabled } = await versionedImport("../config-manager.js", import.meta)

export async function coldAppend(effect, _core) {
    const { stream, entry } = effect
    if (!stream || !entry) {
        dbg("COLD-EFFECT", "invalid cold_append effect:", effect)
        return
    }
    // Hook archival is opt-in. The spinner rolling buffer is the
    // primary UX surface for hook activity; hooks.jsonl grows fast and
    // is only useful for diagnostics/audit. Fresh-read the config so
    // `cbg config set hooks_archive true` takes effect live.
    if (stream === "hooks" && !getHooksArchiveEnabled()) {
        return
    }
    try {
        appendColdEntry(stream, entry)
    } catch (e) {
        dbg("COLD-EFFECT", `append failed for ${stream}:`, e)
    }
}
