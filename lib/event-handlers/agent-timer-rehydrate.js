// lib/event-handlers/agent-timer-rehydrate.js
//
// One-shot event enqueued by main-server.js at startup for each live
// set_reminder / set_repeat record in specialData.agentTimers. Re-arms the
// in-memory set_timer that the restart wiped.
//
// A fire time still ahead of us is honored exactly; one we slept through is
// replayed after a short grace window rather than skipped (see
// lib/pure/agent-timers.js). Stale records are dropped here rather than in
// main-server so the cleanup goes through the normal state/persist path.

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { fireEventFor, resumeDelayMs, isStale } = await versionedImport("../pure/agent-timers.js", import.meta)

export default function handle(event, core) {
    const { timerId } = event
    const record = core.specialData?.agentTimers?.[timerId]
    if (!record) {
        dbg("AGENT-TIMER-REHYDRATE", `${timerId}: no record — nothing to re-arm`)
        return null
    }
    if (isStale(record)) {
        dbg("AGENT-TIMER-REHYDRATE", `${timerId}: stale — dropping`)
        return { stateChanges: { specialData: { agentTimers: { [timerId]: undefined } } } }
    }

    const delayMs = resumeDelayMs(record)
    dbg("AGENT-TIMER-REHYDRATE", `${timerId} (${record.kind}) re-armed for ${record.sessionId} in ${Math.round(delayMs / 1000)}s`)
    return {
        // The record's own fireAt is unchanged: a timer we're re-arming late
        // is still due when it was due, and misses resets because the retry
        // budget is per-delivery-attempt, not for the lifetime of the timer.
        stateChanges: { specialData: { agentTimers: { [timerId]: { misses: 0 } } } },
        effects: [
            { type: "set_timer", delayMs, event: fireEventFor(record) },
        ],
    }
}
