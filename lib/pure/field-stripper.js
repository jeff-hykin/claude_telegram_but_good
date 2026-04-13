// ---------------------------------------------------------------------------
// lib/pure/field-stripper.js
//
// Which fields of a session object get RESET when the daemon restarts,
// and which survive a restart. This file is the single source of
// truth for that split.
//
// ⚠️  Part of the session state machine documented in
//    docs/session-state.md. READ THAT FIRST if you're unsure whether
//    a new field should be in SESSION_FIELDS_RESET_ON_RESTART below.
//
// Session objects in `chatSessions[sid]` are persisted to disk via
// effects/persistence.js on shutdown and loaded back on startup. Most
// fields should survive (id, cwd, title, gitBranch, dtachSocket, and
// the metadata that lets a reconnecting shim prove it's still the
// same session) — but SOME fields encode live-runtime state whose
// persisted values would be stale nonsense on the next boot:
//
//   status               — "working" from a dead process is a lie.
//   agentRequest         — an epoch counter without a matching in-flight
//                          stall_check timer can never tick.
//   agentRequestStartedAt — a timestamp from a prior run.
//   pendingNudgeAction   — scheduled to fire against a prior turn that
//                          no longer has context.
//   screenBufferRecord   — hashes of log bytes from before the restart;
//                          will look "stalled" until new bytes arrive.
//   activeSpinner        — the Telegram message the spinner was editing
//                          is now owned by no live render loop.
//   _conn                — the live Unix-socket handle is gone.
//
// Fields that DO survive and why:
//
//   longTaskId           — the task itself is persisted in specialData;
//                          the session still owns it across the restart
//                          so reconnecting shims can resume work.
//   lastInbound, lastOutboundAt, lastStopAt, lastActive — historical
//                          timestamps the post-restart Stop-hook
//                          watchdog can still use meaningfully.
//
// This module is a SINGLE POINT OF TRUTH for the strip rule. If you
// add a new live-runtime field to the session shape, add it to
// `SESSION_FIELDS_RESET_ON_RESTART` here — main-server.js's load
// path picks it up automatically.
// ---------------------------------------------------------------------------

/**
 * The field names that get RESET when the daemon restarts. Values of
 * these keys are removed from every persisted session during the
 * chatSessions.json load step, so they come back fresh on the next
 * run instead of carrying stale content from the previous process.
 */
export const SESSION_FIELDS_RESET_ON_RESTART = Object.freeze([
    "_conn",
    "activeSpinner",
    "status",
    "agentRequest",
    "agentRequestStartedAt",
    "pendingNudgeAction",
    "screenBufferRecord",
])

/**
 * Return a shallow copy of `session` with every
 * `SESSION_FIELDS_RESET_ON_RESTART` field removed. Pure — does not
 * mutate `session`. Returns `undefined` if the input is nullish or
 * non-object (persistence treats that as "drop this session
 * entirely").
 */
export function stripFieldsResetOnRestart(session) {
    if (!session || typeof session !== "object") {
        return undefined
    }
    const out = {}
    for (const [k, v] of Object.entries(session)) {
        if (SESSION_FIELDS_RESET_ON_RESTART.includes(k)) {
            continue
        }
        out[k] = v
    }
    return out
}

/**
 * Map `stripFieldsResetOnRestart` across an entire chatSessions map.
 * Drops sessions that stripped down to `undefined`. Pure.
 */
export function stripFieldsResetOnRestartFromAllSessions(chatSessions) {
    if (!chatSessions || typeof chatSessions !== "object") {
        return {}
    }
    const out = {}
    for (const [sid, sess] of Object.entries(chatSessions)) {
        const stripped = stripFieldsResetOnRestart(sess)
        if (stripped) {
            out[sid] = stripped
        }
    }
    return out
}
