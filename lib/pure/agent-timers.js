// ---------------------------------------------------------------------------
// lib/pure/agent-timers.js — durable bookkeeping for the set_reminder /
// set_repeat timers an agent arms for itself.
//
// The timer itself is an in-memory `set_timer` effect (a bare setTimeout in
// the daemon process), so a restart wipes it. Every live timer therefore also
// gets a RECORD in `specialData.agentTimers`, which IS persisted to disk, and
// main-server.js replays those records on boot. Without this a daemon restart
// silently ate every pending reminder — no error, no notification.
//
// Record shape (all plain JSON so it survives the persistence layer's
// underscore-stripping and JSON round-trip):
//
//   {
//       id, sessionId, message,
//       kind: "reminder" | "repeat",
//       createdAt: epoch ms, fireAt: epoch ms,
//       intervalMs: number|null, maxCount: number|null, fireCount: number,
//       misses: number,          // consecutive fires the session was away for
//   }
//
// Pure, no I/O, no versionedImport.
// ---------------------------------------------------------------------------

// A timer we slept through is replayed shortly after boot rather than
// skipped. The delay also buys the session's shim time to reconnect its IPC
// socket, which it only does after the daemon is back up.
export const RESUME_GRACE_MS = 30 * 1000

// A fire that lands while the session is away is retried on this cadence.
export const RECONNECT_RETRY_MS = 30 * 1000

// ...but only this many times (5 min). After that the message is delivered
// anyway — deliver_channel_event still writes the session inbox when the
// socket is down, so the reminder lands somewhere readable instead of
// vanishing.
export const MAX_RECONNECT_RETRIES = 10

// A one-shot whose fire time is this far in the past is junk left behind by
// something that died mid-write; don't resurrect it on boot.
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000

export function makeTimerRecord({
    id,
    sessionId,
    message,
    kind,
    fireAt,
    intervalMs = null,
    maxCount = null,
    fireCount = 0,
    createdAt = null,
}) {
    return {
        id,
        sessionId,
        message,
        kind,
        createdAt: createdAt ?? Date.now(),
        fireAt,
        intervalMs,
        maxCount,
        fireCount,
        misses: 0,
    }
}

/**
 * Rebuild the `agent_timer_fire` event a record stands for. Used both when
 * re-arming after a restart and when retrying a fire the session missed.
 */
export function fireEventFor(record) {
    const event = {
        type: "agent_timer_fire",
        sessionId: record.sessionId,
        timerId: record.id,
        message: record.message,
        kind: record.kind,
    }
    if (record.kind === "repeat") {
        event.intervalMs = record.intervalMs
        event.maxCount = record.maxCount ?? null
        event.fireCount = record.fireCount ?? 0
    }
    return event
}

/**
 * How long after a restart to re-arm a record's timer.
 *
 * A fire time still ahead of us is honored exactly; one we slept through is
 * replayed after the grace window. Re-deriving from `now` instead would let a
 * run of restarts push a repeat past its own interval forever — the same bug
 * lib/scheduler/index.js's resolveResumeFire exists to avoid.
 */
export function resumeDelayMs(record, now = Date.now()) {
    const at = Number(record?.fireAt)
    if (!Number.isFinite(at)) {
        return RESUME_GRACE_MS
    }
    return at > now ? at - now : RESUME_GRACE_MS
}

/** True for a record that should be dropped on boot rather than re-armed. */
export function isStale(record, now = Date.now()) {
    if (!record || typeof record !== "object") {
        return true
    }
    if (typeof record.sessionId !== "string" || !record.sessionId) {
        return true
    }
    if (typeof record.message !== "string" || !record.message) {
        return true
    }
    const at = Number(record.fireAt)
    if (!Number.isFinite(at)) {
        return true
    }
    // A repeat's fireAt is just where the cadence had got to; being overdue
    // means the daemon was down, not that the timer is garbage.
    if (record.kind === "repeat") {
        return false
    }
    return now - at > STALE_AFTER_MS
}
