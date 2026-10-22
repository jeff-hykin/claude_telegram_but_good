// ---------------------------------------------------------------------------
// agent_timer_fire handler.
//
// Fires when a set_reminder or set_repeat timer goes off. Delivers the
// agent's message as a channel event. For repeats, re-schedules the
// next tick unless maxCount is reached or the timer was cancelled.
//
// Also maintains the timer's durable record in specialData.agentTimers so a
// daemon restart can replay it (see lib/pure/agent-timers.js). A fire that
// lands while the session is away — which is the normal state for the first
// half-minute after a restart, before the shim reconnects its socket — is
// retried rather than dropped.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const {
    RECONNECT_RETRY_MS,
    MAX_RECONNECT_RETRIES,
} = await versionedImport("../pure/agent-timers.js", import.meta)

const dropRecord = (timerId) => ({ specialData: { agentTimers: { [timerId]: undefined } } })

export default function handle(event, core) {
    const { sessionId, timerId, message, kind, intervalMs, maxCount, fireCount } = event

    const session = core.chatSessions?.[sessionId]
    const record = core.specialData?.agentTimers?.[timerId]

    // Check if cancelled.
    if (session?.cancelledTimers?.[timerId]) {
        dbg("AGENT-TIMER", `${timerId} cancelled — skipping`)
        return record ? { stateChanges: dropRecord(timerId) } : null
    }

    const now = event.ts ?? Date.now()
    const misses = event.misses ?? record?.misses ?? 0

    // Session isn't reachable yet. Give its shim time to come back before
    // giving up — a restart wipes every _conn and the shims reconnect over
    // the following seconds, so bailing here is what used to make a reminder
    // that outlived the daemon still vanish.
    if (!session?._conn && misses < MAX_RECONNECT_RETRIES) {
        dbg("AGENT-TIMER", `session ${sessionId} away — retrying ${timerId} in ${RECONNECT_RETRY_MS}ms (miss ${misses + 1}/${MAX_RECONNECT_RETRIES})`)
        return {
            stateChanges: record
                ? { specialData: { agentTimers: { [timerId]: { misses: misses + 1, fireAt: now + RECONNECT_RETRY_MS } } } }
                : {},
            effects: [{
                type: "set_timer",
                delayMs: RECONNECT_RETRY_MS,
                event: { ...event, ts: undefined, misses: misses + 1 },
            }],
        }
    }

    const nextCount = (fireCount ?? 0) + 1
    if (!session?._conn) {
        // Out of retries. Deliver anyway: deliver_channel_event still writes
        // the session's inbox when the socket is down, so the reminder is
        // readable later instead of disappearing without a trace.
        dbg("AGENT-TIMER", `session ${sessionId} still gone after ${misses} retries — delivering ${timerId} to the inbox only`)
        return {
            stateChanges: dropRecord(timerId),
            effects: [{
                type: "deliver_channel_event",
                sessionId,
                content: message,
                meta: { source: "agent_timer", timerId, kind },
            }],
        }
    }

    dbg("AGENT-TIMER", `${timerId} fired (${kind}, #${nextCount}) for ${sessionId}`)

    const effects = [
        {
            type: "deliver_channel_event",
            sessionId,
            content: message,
            meta: { source: "agent_timer", timerId, kind },
        },
    ]

    const stateChanges = {}

    // Store the message for snooze support. Underscore-prefixed, so this copy
    // does NOT survive a restart — the durable record in specialData is what
    // snooze_reminder actually falls back on.
    const lastMessages = { ...(session._lastTimerMessages ?? {}), [timerId]: message }
    stateChanges.chatSessions = {
        [sessionId]: { _lastTimerMessages: lastMessages },
    }

    // For repeats, reschedule unless done.
    const repeating = kind === "repeat" && intervalMs
    const done = !repeating || (maxCount != null && nextCount >= maxCount)
    if (repeating && !done) {
        effects.push({
            type: "set_timer",
            delayMs: intervalMs,
            event: {
                type: "agent_timer_fire",
                sessionId,
                timerId,
                message,
                kind: "repeat",
                intervalMs,
                maxCount,
                fireCount: nextCount,
            },
        })
    } else if (repeating) {
        dbg("AGENT-TIMER", `${timerId} reached maxCount ${maxCount} — stopping`)
    }

    // A one-shot that just fired, or a repeat that just ran out, is done and
    // its record goes away; a live repeat records where its cadence got to so
    // a restart resumes from there instead of re-deriving from boot time.
    stateChanges.specialData = done
        ? dropRecord(timerId).specialData
        : { agentTimers: { [timerId]: { fireAt: now + intervalMs, fireCount: nextCount, misses: 0 } } }

    return { stateChanges, effects }
}
