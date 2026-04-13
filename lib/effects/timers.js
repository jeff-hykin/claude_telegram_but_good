/**
 * Timer tooling for the event loop.
 *
 * Handlers return `{ type: "set_timer", delayMs, event }` effects.
 * When the delay elapses, the stored event is pushed to the FRONT of
 * the event queue so it jumps ahead of normal events. There is no
 * cancellation mechanism in v1 — if a timer fires and the state has
 * changed, the handler for the event checks state and bails.
 *
 * Why front-of-queue? Timers are typically follow-ups to a prior
 * handler decision ("nudge in 10 min"). When they fire, they carry
 * high-urgency context and shouldn't wait behind a backlog.
 */

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)

/**
 * effect shape: { type: "set_timer", delayMs: number, event: Event }
 */
export function setTimer(effect, core) {
    const { delayMs, event } = effect
    if (typeof delayMs !== "number" || delayMs < 0) {
        dbg("TIMERS", "set_timer: invalid delayMs", delayMs)
        return
    }
    if (!event || typeof event.type !== "string") {
        dbg("TIMERS", "set_timer: invalid event payload")
        return
    }
    if (typeof core.enqueueEventFront !== "function") {
        dbg("TIMERS", "set_timer: core.enqueueEventFront is not a function")
        return
    }
    const scheduledAt = Date.now()
    setTimeout(() => {
        const fired = { ...event, ts: Date.now(), _scheduledAt: scheduledAt }
        try {
            core.enqueueEventFront(fired)
        } catch (e) {
            dbg("TIMERS", "enqueueEventFront failed:", e)
        }
    }, delayMs)
    dbg("TIMERS", `scheduled ${event.type} in ${delayMs}ms`)
}
