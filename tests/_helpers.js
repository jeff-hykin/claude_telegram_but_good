// tests/_helpers.js
//
// Shared test utilities for the event-handler unit tests.
//
// The path singleton at `lib/paths.js` is mutated in place so each test
// can redirect CBG's filesystem layout into a temp directory without
// touching anything real. Handlers read `paths.X` at call-time via
// versionedImport, so the mutation is picked up the next time the
// handler runs — there's no need to re-import modules.
//
// We import paths through `versionedImport` (not a bare static import)
// so the helper and every hot-reloadable file share the same
// cache-busted module URL (`.../paths.js?v=<cbgVersion>`) and therefore
// the same `paths` object. A bare static import would resolve to a
// DIFFERENT URL and produce a second independent singleton; mutations
// on one would be invisible on the other.

import { versionedImport } from "../lib/version.js"

const pathsMod = await versionedImport("../lib/paths.js", import.meta)
export const paths = pathsMod.paths
const buildPaths = pathsMod.buildPaths

/**
 * Redirect the `paths` singleton at a fresh temp directory and create
 * the runtime subdirs handlers may touch.
 *
 * Returns `{ tempDir, paths }` for convenience. Callers should NOT
 * expect isolation from earlier calls — the mutation is destructive,
 * so any state that lives in paths.STATE_DIR is effectively wiped.
 */
export function setupTempPaths(prefix = "cbg-handler-test-") {
    const tempDir = Deno.makeTempDirSync({ prefix })
    Object.assign(paths, buildPaths({ cbgDir: tempDir, claudeDir: tempDir }))
    Deno.mkdirSync(paths.STATE_DIR, { recursive: true })
    Deno.mkdirSync(paths.INBOX_DIR, { recursive: true })
    Deno.mkdirSync(paths.LONG_TASKS_DIR, { recursive: true })
    Deno.mkdirSync(paths.COLD_STORAGE_DIR, { recursive: true })
    return { tempDir, paths }
}

/**
 * Write an access.json file with a specific allowFrom list into the
 * current paths.STATE_DIR. Used by handlers that gate on the allowlist.
 */
export function writeAccess(allowFrom = []) {
    Deno.writeTextFileSync(
        paths.ACCESS_FILE,
        JSON.stringify({
            dmPolicy: "pairing",
            allowFrom,
            groups: {},
            pending: {},
        }, null, 2),
    )
}

/**
 * Build a minimal `core` kernel object shaped like main-server.js's.
 * State slices use getter/setter pairs so handler-initiated mutations
 * through `core.chatState = ...` go through a single source of truth,
 * matching the real kernel. Captured enqueued events land on
 * `core._enqueuedEvents` for assertion.
 */
export function makeCore({
    chatState = {},
    chatSessions = {},
    specialData = {},
    bot = null,
} = {}) {
    let _chatState = chatState
    let _chatSessions = chatSessions
    let _specialData = specialData
    const enqueuedEvents = []
    return {
        get chatState() { return _chatState },
        set chatState(v) { _chatState = v },
        get chatSessions() { return _chatSessions },
        set chatSessions(v) { _chatSessions = v },
        get specialData() { return _specialData },
        set specialData(v) { _specialData = v },
        bot,
        ipcListener: null,
        ipcConns: new Map(),
        enqueueEvent: (ev) => { enqueuedEvents.push(ev) },
        enqueueEventFront: (ev) => { enqueuedEvents.unshift(ev) },
        version: 1,
        _enqueuedEvents: enqueuedEvents,
    }
}

/**
 * Return a sentinel object that stands in for a Unix-socket conn. Has
 * a label for debugging and no-op read/write/close methods so effects
 * that try to drive it don't crash.
 */
export function fakeConn(label = "conn") {
    return {
        __label: label,
        write: () => Promise.resolve(),
        read: () => Promise.resolve(null),
        close: () => {},
    }
}

/**
 * Return only the effects matching `type`. Convenience for tests that
 * assert on a specific kind without caring about ordering.
 */
export function effectsOfType(action, type) {
    return (action?.effects ?? []).filter(e => e && e.type === type)
}

/**
 * Small deep-get helper so tests can read nested fields concisely:
 * `get(action, "stateChanges.chatState.focusedSessionId")`.
 */
export function get(obj, path) {
    let cur = obj
    for (const key of path.split(".")) {
        if (cur == null) { return cur }
        cur = cur[key]
    }
    return cur
}
