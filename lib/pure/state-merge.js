// ---------------------------------------------------------------------------
// lib/pure/state-merge.js — deep-merge used by onEvent to apply state
// patches returned by handlers.
//
// Pure, no I/O, no versionedImport. The event loop calls mergeSessionData
// once per Action against each of the three top-level state objects
// (chatState, chatSessions, specialData). Handlers return PARTIAL patches;
// this function produces a new, unshared object graph so reads elsewhere
// never observe half-applied writes.
// ---------------------------------------------------------------------------

/**
 * Merge a patch into target session data without mutating target.
 *
 * Semantics:
 *  - patch === null         -> returns null (caller decides what to do)
 *  - patch === undefined    -> returns undefined (sentinel: delete this key)
 *  - patch is primitive     -> returns patch (replaces)
 *  - patch is an array      -> returns patch (arrays replace wholesale)
 *  - patch is a non-plain object (foreign prototype, e.g. UnixConn, Map,
 *    Set, Date, class instances) -> returns patch (replaces by reference;
 *    we never recurse into objects whose prototype isn't Object.prototype)
 *  - patch is a plain object-> recursively merged with target
 *
 * Underscore-prefixed keys (`_conn`, `_resolve`, etc.) are the project
 * convention for non-serializable opaque values. The merge treats their
 * VALUES as opaque: replaced by reference, never recursed into. This
 * lets handlers attach live IPC connections / resolvers to state
 * entries without the merger deep-cloning them.
 *
 * For plain-object patches, target may be undefined/null/non-object;
 * it is treated as an empty object in that case.
 */
function isPlainObject(value) {
    if (value === null || typeof value !== "object") {
        return false
    }
    if (Array.isArray(value)) {
        return false
    }
    const proto = Object.getPrototypeOf(value)
    return proto === Object.prototype || proto === null
}

export function mergeSessionData(target, patch) {
    if (patch === null) {
        return null
    }
    if (patch === undefined) {
        return undefined
    }
    if (typeof patch !== "object") {
        return patch
    }
    if (Array.isArray(patch)) {
        return patch
    }
    // Non-plain objects (UnixConn, Deno.Command, etc.) are replaced by
    // reference — do NOT recurse into their internals.
    if (!isPlainObject(patch)) {
        return patch
    }

    // plain object merge — never mutate target
    const base = isPlainObject(target) ? target : {}
    const out = {}
    for (const key of Object.keys(base)) {
        out[key] = base[key]
    }
    for (const key of Object.keys(patch)) {
        const value = patch[key]
        if (value === undefined) {
            delete out[key]
            continue
        }
        // Underscore-prefixed keys are opaque: replace by reference, never
        // recurse. This preserves reference equality for things like `_conn`
        // which handlers use to route replies back to a specific socket.
        if (key.startsWith("_")) {
            out[key] = value
            continue
        }
        const merged = mergeSessionData(base[key], value)
        if (merged === undefined) {
            delete out[key]
        } else {
            out[key] = merged
        }
    }
    return out
}
