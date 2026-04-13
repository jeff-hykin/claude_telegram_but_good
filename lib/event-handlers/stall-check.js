// ---------------------------------------------------------------------------
// lib/event-handlers/stall-check.js
//
// Per-session stall detector. Scheduled via `set_timer` whenever a session
// transitions into a waiting state (a user message arrives while the
// session is idle/frozen, or a long task kicks off). The scheduled event
// carries `forAgentRequest: N` — the counter value at scheduling time.
//
// Generation guards:
//   - If session.agentRequest !== forAgentRequest, the timer is stale (a
//     newer waiting state has superseded it). Exit silently — the new
//     request scheduled its own check.
//   - If session.status === "idle", the agent finished naturally (Stop
//     fired, worker replied). Exit silently.
//
// Stall detection:
//   - Look at session.screenBufferRecord. Find the subset that's older
//     than `stall_detected_ms`. If that subset spans the full stall
//     window (oldest entry ≥ stall_detected_ms old) AND every hash in
//     the window equals the most-recent hash → stalled.
//
// On stall:
//   - Patch session.status = "frozen".
//   - Enqueue a synthetic `claude_hook_stop` event. The Stop handler
//     does the rest (clears pendingNudgeAction, fires the appropriate
//     nudge, transitions status to idle).
//   - Do NOT reschedule. The synthetic Stop resets status; the next
//     waiting state will schedule a fresh stall_check.
//
// Not stalled (screen is still moving):
//   - Reschedule another stall_check for `stall_check_interval_ms` out
//     with the SAME forAgentRequest.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const {
    getStallDetectedMs,
    getStallCheckIntervalMs,
} = await versionedImport("../config-manager.js", import.meta)

/**
 * Decide whether the ring buffer indicates a stall at the given ts.
 *
 * Pure; exported for tests.
 *
 * @param {Array<{hash:string, ts:number}>} record
 * @param {number} now
 * @param {number} stallMs
 * @returns {boolean} true iff every snapshot ≥ stallMs old has the same
 *   hash as the most recent snapshot AND the oldest entry in that slice
 *   is at least stallMs old.
 */
export function isStalled(record, now, stallMs) {
    if (!Array.isArray(record) || record.length === 0) {
        return false
    }
    const latest = record[record.length - 1]
    if (!latest || typeof latest.hash !== "string") {
        return false
    }
    // Need at least one sample older than the stall window — otherwise
    // we don't have enough history yet to say anything.
    const oldest = record[0]
    if (!oldest || now - oldest.ts < stallMs) {
        return false
    }
    // Every sample in the window must match the latest hash.
    for (const entry of record) {
        if (!entry || entry.hash !== latest.hash) {
            return false
        }
    }
    return true
}

/**
 * Event shape:
 *   {
 *     type: "stall_check",
 *     sessionId: "CalmLion",
 *     forAgentRequest: 7,
 *     ts: 1728675432000,
 *   }
 */
export default function handle(event, core) {
    const { sessionId, forAgentRequest } = event
    if (!sessionId) {
        dbg("STALL-CHECK", "missing sessionId")
        return { stateChanges: {}, effects: [] }
    }

    const session = core.chatSessions?.[sessionId]
    if (!session) {
        dbg("STALL-CHECK", `session ${sessionId} gone — exiting`)
        return { stateChanges: {}, effects: [] }
    }

    // Stale timer: a newer waiting state has superseded this one.
    if (session.agentRequest !== forAgentRequest) {
        dbg(
            "STALL-CHECK",
            `stale: ${sessionId} agentRequest=${session.agentRequest} but timer is for ${forAgentRequest}`,
        )
        return { stateChanges: {}, effects: [] }
    }

    // Agent finished naturally — nothing to check.
    if (session.status === "idle") {
        dbg("STALL-CHECK", `${sessionId} already idle — exiting`)
        return { stateChanges: {}, effects: [] }
    }

    const stallMs = getStallDetectedMs()
    const intervalMs = getStallCheckIntervalMs()
    const now = event.ts ?? Date.now()

    if (isStalled(session.screenBufferRecord, now, stallMs)) {
        dbg(
            "STALL-CHECK",
            `STALLED ${sessionId} (request ${forAgentRequest}) — firing synthetic claude_hook_stop`,
        )
        return {
            stateChanges: {
                chatSessions: {
                    [sessionId]: { status: "frozen" },
                },
            },
            effects: [],
            followUpEvents: [
                {
                    type: "claude_hook_stop",
                    sessionId,
                    ts: now,
                    synthetic: true,
                    claudePid: null,
                },
            ],
        }
    }

    // Screen is still moving. Reschedule another check.
    dbg(
        "STALL-CHECK",
        `${sessionId} still active (request ${forAgentRequest}) — rescheduling in ${intervalMs}ms`,
    )
    return {
        stateChanges: {},
        effects: [
            {
                type: "set_timer",
                delayMs: intervalMs,
                event: {
                    type: "stall_check",
                    sessionId,
                    forAgentRequest,
                },
            },
        ],
    }
}
