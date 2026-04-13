// lib/scheduler/timer-registry.js
//
// Module-level Map<scheduleTaskId, timerHandle>. Lives outside of
// `core` because setTimeout handles are inherently imperative
// in-process resources that don't serialize. Timer state is rebuilt
// on every daemon startup from specialData.scheduledTaskByChatId (see
// main-server.js's startup rehydration path).

import { versionedImport } from "../version.js"
const { dbg } = await versionedImport("../logging.js", import.meta)

const timers = new Map()

/**
 * Register a timer. If a timer already exists for this taskId, it is
 * cleared first. `onFire` is called from the setTimeout callback; if
 * it throws, the error is logged but the loop is not affected.
 */
export function setScheduleTimer(taskId, fireAtDate, onFire) {
    clearScheduleTimer(taskId)
    const delayMs = Math.max(0, fireAtDate.getTime() - Date.now())
    const handle = setTimeout(() => {
        timers.delete(taskId)
        try {
            onFire()
        } catch (e) {
            dbg("SCHED-TIMER", `onFire threw for ${taskId}:`, e)
        }
    }, delayMs)
    timers.set(taskId, handle)
    dbg("SCHED-TIMER", `set ${taskId} → fire in ${delayMs}ms (${fireAtDate.toISOString()})`)
}

export function clearScheduleTimer(taskId) {
    const handle = timers.get(taskId)
    if (handle !== undefined) {
        clearTimeout(handle)
        timers.delete(taskId)
        dbg("SCHED-TIMER", `cleared ${taskId}`)
    }
}

export function listActiveTimers() {
    return Array.from(timers.keys())
}

/** Test helper — wipes every timer. Not used in production. */
export function _resetForTest() {
    for (const h of timers.values()) { clearTimeout(h) }
    timers.clear()
}
