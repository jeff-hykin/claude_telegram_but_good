// ---------------------------------------------------------------------------
// agent_timer_fire handler.
//
// Fires when a set_reminder or set_repeat timer goes off. Delivers the
// agent's message as a channel event. For repeats, re-schedules the
// next tick unless maxCount is reached or the timer was cancelled.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)

export default function handle(event, core) {
    const { sessionId, timerId, message, kind, intervalMs, maxCount, fireCount } = event

    const session = core.chatSessions?.[sessionId]
    if (!session?._conn) {
        dbg("AGENT-TIMER", `session ${sessionId} gone — dropping ${timerId}`)
        return null
    }

    // Check if cancelled.
    if (session.cancelledTimers?.[timerId]) {
        dbg("AGENT-TIMER", `${timerId} cancelled — skipping`)
        return null
    }

    const nextCount = (fireCount ?? 0) + 1
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

    // Store the message for snooze support.
    const lastMessages = { ...(session._lastTimerMessages ?? {}), [timerId]: message }
    stateChanges.chatSessions = {
        [sessionId]: { _lastTimerMessages: lastMessages },
    }

    // For repeats, reschedule unless done.
    if (kind === "repeat" && intervalMs) {
        if (maxCount != null && nextCount >= maxCount) {
            dbg("AGENT-TIMER", `${timerId} reached maxCount ${maxCount} — stopping`)
        } else {
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
        }
    }

    return { stateChanges, effects }
}
