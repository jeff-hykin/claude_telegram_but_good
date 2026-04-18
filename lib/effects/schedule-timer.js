// lib/effects/schedule-timer.js
//
// Effects that register / clear in-process schedule timers. Timer
// state lives in lib/scheduler/timer-registry.js (not on core) because
// setTimeout handles aren't serializable. When a timer fires, it
// enqueues a `scheduled_task_fire` event through core.enqueueEvent.

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { computeNextFire } = await versionedImport("../scheduler/index.js", import.meta)
const { setScheduleTimer, clearScheduleTimer } = await versionedImport("../scheduler/timer-registry.js", import.meta)

/**
 * effect shape: { type: "schedule_timer_set", chatId, scheduleTaskId, rule, from? }
 *
 * Computes the next fire time from `rule` relative to `from` (defaults
 * to now), then registers a setTimeout that enqueues a
 * `scheduled_task_fire` event when it fires. If the rule is exhausted
 * (count/until rolled past), no timer is registered and the task is
 * transitioned to state="completed".
 *
 * Returns a `{ stateChanges }` patch recording `tracking.nextFireAt`
 * (advisory only — the rule remains the source of truth).
 */
export async function scheduleTimerSet(effect, core) {
    const { chatId, scheduleTaskId, rule, from } = effect
    if (!chatId || !scheduleTaskId || !rule) {
        dbg("SCHED-TIMER", "schedule_timer_set: missing chatId/scheduleTaskId/rule")
        return
    }
    // On initial creation (no `from`), use inclusive mode so that
    // count-limited rules (e.g. count=1) whose first occurrence is
    // AT now are found. On rearm after a fire, use exclusive mode
    // to avoid double-firing the same occurrence.
    const fromDate = from ? new Date(from) : new Date()
    const inclusive = !from
    let next
    try {
        next = computeNextFire(rule, fromDate, { inclusive })
    } catch (e) {
        dbg("SCHED-TIMER", `computeNextFire threw for ${scheduleTaskId}:`, e)
        return
    }
    if (!next) {
        dbg("SCHED-TIMER", `rule exhausted for ${scheduleTaskId}; no timer set`)
        return {
            stateChanges: {
                specialData: {
                    scheduledTaskByChatId: {
                        [chatId]: {
                            [scheduleTaskId]: {
                                state: "completed",
                                tracking: { nextFireAt: null },
                            },
                        },
                    },
                },
            },
        }
    }

    const nextIso = next.toISOString()
    setScheduleTimer(scheduleTaskId, next, () => {
        try {
            core.enqueueEvent?.({
                type: "scheduled_task_fire",
                chatId,
                scheduleTaskId,
                fireIso: nextIso,
            })
        } catch (e) {
            dbg("SCHED-TIMER", `enqueue on fire threw for ${scheduleTaskId}:`, e)
        }
    })

    return {
        stateChanges: {
            specialData: {
                scheduledTaskByChatId: {
                    [chatId]: {
                        [scheduleTaskId]: {
                            tracking: { nextFireAt: nextIso },
                        },
                    },
                },
            },
        },
    }
}

/**
 * effect shape: { type: "schedule_timer_clear", scheduleTaskId }
 */
export async function scheduleTimerClear(effect, _core) {
    const { scheduleTaskId } = effect
    if (!scheduleTaskId) { return }
    clearScheduleTimer(scheduleTaskId)
}
