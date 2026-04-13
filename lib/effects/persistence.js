/**
 * Debounced disk persistence for core state objects.
 *
 * main-server.js calls setCoreRef(core) once at startup. After that,
 * handlers can call schedulePersist("specialData" | "chatState" | "chatSessions")
 * and the next flush (debounced by config.persistence_debounce_ms)
 * will atomically write
 * paths.STATE_DIR/<which>.json.
 *
 * Write strategy: JSON.stringify(cleaned, null, 2) → temp file → rename,
 * so readers never see a half-written file. Non-serializable keys
 * (those prefixed with underscore — e.g. `_conn`, `_resolve`) are
 * stripped recursively before serialization.
 */

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { randomHex } = await versionedImport("../pure/ids.js", import.meta)
const { paths } = await versionedImport("../paths.js", import.meta)
const { getPersistenceDebounceMs } = await versionedImport("../config-manager.js", import.meta)

const dirty = new Set() // "specialData" | "chatState" | "chatSessions"
let flushHandle = null
let coreRef = null

export function setCoreRef(core) {
    coreRef = core
}

export function schedulePersist(which) {
    dirty.add(which)
    if (flushHandle) {
        return
    }
    flushHandle = setTimeout(() => {
        flushHandle = null
        for (const name of dirty) {
            flushOne(name)
        }
        dirty.clear()
    }, getPersistenceDebounceMs())
}

export function flushPersistenceNow() {
    if (flushHandle) {
        clearTimeout(flushHandle)
        flushHandle = null
    }
    // Unconditionally flush ALL three state slices on shutdown/reload.
    // chatState and chatSessions are rarely scheduled (they're "reload
    // survival" only, not hot-persisted), so if we only flushed the
    // dirty set we'd lose them across a restart. specialData is always
    // safe to flush even if not dirty — it's a no-op for unchanged content.
    flushOne("chatState")
    flushOne("chatSessions")
    flushOne("specialData")
    dirty.clear()
}

/**
 * Load persisted state back from disk. Returns `{ chatState, chatSessions, specialData }`
 * with any slice that couldn't be loaded returned as `null` so callers
 * can fall back to defaults. Called once on startup by main-server.js.
 */
export function loadPersistedState() {
    return {
        chatState: loadOne("chatState"),
        chatSessions: loadOne("chatSessions"),
        specialData: loadOne("specialData"),
    }
}

function loadOne(which) {
    const target = paths.persistenceFile(which)
    try {
        const raw = Deno.readTextFileSync(target)
        const parsed = JSON.parse(raw)
        dbg("PERSIST", `loaded ${which}.json`)
        return parsed
    } catch (e) {
        if (e instanceof Deno.errors.NotFound) {
            dbg("PERSIST", `no ${which}.json on disk (first boot)`)
        } else {
            dbg("PERSIST", `read ${which} failed:`, e)
        }
        return null
    }
}

function flushOne(which) {
    if (!coreRef) {
        dbg("PERSIST", "no core ref, cannot flush", which)
        return
    }
    const obj = coreRef[which]
    if (obj === undefined) {
        return
    }
    const cleaned = stripNonSerializable(obj)
    const target = paths.persistenceFile(which)
    const tmp = `${target}.tmp.${Deno.pid}.${randomHex(2)}`
    try {
        Deno.writeTextFileSync(tmp, JSON.stringify(cleaned, null, 2))
        Deno.renameSync(tmp, target)
        dbg("PERSIST", `wrote ${which}.json`)
    } catch (e) {
        dbg("PERSIST", `write ${which} failed:`, e)
    }
}

function stripNonSerializable(obj) {
    if (obj === null || typeof obj !== "object") {
        return obj
    }
    if (Array.isArray(obj)) {
        return obj.map(stripNonSerializable)
    }
    const out = {}
    for (const [k, v] of Object.entries(obj)) {
        if (k.startsWith("_")) {
            continue
        }
        if (typeof v === "function") {
            continue
        }
        out[k] = stripNonSerializable(v)
    }
    return out
}
