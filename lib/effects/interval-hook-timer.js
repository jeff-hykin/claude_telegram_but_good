// lib/effects/interval-hook-timer.js
//
// Effects that register / clear in-process interval-hook timers. Timer
// state lives in lib/scheduler/timer-registry.js (shared with scheduled
// tasks — ids never collide: hooks are "ih_*", tasks are "sch_*").
// When a timer fires, it enqueues an `interval_hook_fire` event.

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { computeNextFire } = await versionedImport("../scheduler/index.js", import.meta)
const { setScheduleTimer, clearScheduleTimer } = await versionedImport("../scheduler/timer-registry.js", import.meta)

/**
 * effect shape: { type: "interval_hook_timer_set", chatId, hookId, rule, from? }
 *
 * Computes the next fire from `rule` relative to `from` (defaults to now)
 * and registers a setTimeout that enqueues `interval_hook_fire`. On
 * initial creation (no `from`) uses inclusive mode; on rearm uses
 * exclusive mode to avoid double-firing the same occurrence.
 */
export async function intervalHookTimerSet(effect, core) {
    const { chatId, hookId, rule, from } = effect
    if (!chatId || !hookId || !rule) {
        dbg("IHOOK-TIMER", "interval_hook_timer_set: missing chatId/hookId/rule")
        return
    }

    const fromDate = from ? new Date(from) : new Date()
    const inclusive = !from

    // Enforce count limit using actual run history, not rrule's count
    // (which resets each time we build a fresh RRule with a new dtstart).
    if (rule.count != null) {
        const hook = core.specialData?.intervalHookByChatId?.[chatId]?.[hookId]
        const totalRuns = hook?.tracking?.totalRuns ?? 0
        if (totalRuns >= rule.count) {
            dbg("IHOOK-TIMER", `count limit reached for ${hookId} (${totalRuns}/${rule.count}); deactivating`)
            return {
                stateChanges: {
                    specialData: {
                        intervalHookByChatId: {
                            [chatId]: {
                                [hookId]: {
                                    active: false,
                                    tracking: { nextFireAt: null },
                                },
                            },
                        },
                    },
                },
            }
        }
    }

    let next
    try {
        next = computeNextFire(rule, fromDate, { inclusive })
    } catch (e) {
        dbg("IHOOK-TIMER", `computeNextFire threw for ${hookId}:`, e)
        return
    }
    if (!next) {
        dbg("IHOOK-TIMER", `rule exhausted for ${hookId}; deactivating`)
        return {
            stateChanges: {
                specialData: {
                    intervalHookByChatId: {
                        [chatId]: {
                            [hookId]: {
                                active: false,
                                tracking: { nextFireAt: null },
                            },
                        },
                    },
                },
            },
        }
    }

    const nextIso = next.toISOString()
    setScheduleTimer(hookId, next, () => {
        try {
            core.enqueueEvent?.({
                type: "interval_hook_fire",
                chatId,
                hookId,
                fireIso: nextIso,
            })
        } catch (e) {
            dbg("IHOOK-TIMER", `enqueue on fire threw for ${hookId}:`, e)
        }
    })

    return {
        stateChanges: {
            specialData: {
                intervalHookByChatId: {
                    [chatId]: {
                        [hookId]: {
                            tracking: { nextFireAt: nextIso },
                        },
                    },
                },
            },
        },
    }
}

/**
 * effect shape: { type: "interval_hook_timer_clear", hookId }
 */
export async function intervalHookTimerClear(effect, _core) {
    const { hookId } = effect
    if (!hookId) { return }
    clearScheduleTimer(hookId)
}
