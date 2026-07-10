// lib/event-handlers/interval-hook-fire.js
//
// An interval-hook timer fired. Decide whether to run the decision
// function (skip if deactivated, a previous run is still in flight, or
// skipNext is set) and — unlike scheduled tasks — do NOT rearm here on
// the run path: the rearm happens in interval_hook_run_complete once the
// decision function finishes.

import { versionedImport } from "../version.js"
const { dbg } = await versionedImport("../logging.js", import.meta)
const { findIntervalHook } = await versionedImport("../interval-hook-actions.js", import.meta)

export default function handle(event, core) {
    const { chatId, hookId, fireIso } = event
    const found = findIntervalHook(core.specialData, hookId)
    if (!found) {
        dbg("IHOOK-FIRE", `hook ${hookId} not found; swallowing fire`)
        return null
    }
    const hook = found.hook

    if (!hook.active) {
        dbg("IHOOK-FIRE", `hook ${hookId} deactivated; skipping (no rearm)`)
        return null
    }

    // Previous run still in flight — skip this fire and rearm.
    if (hook.currentRun) {
        dbg("IHOOK-FIRE", `hook ${hookId} still running previous fire; skipping + rearming`)
        return {
            effects: [
                { type: "interval_hook_timer_set", chatId, hookId, rule: hook.rule, from: new Date().toISOString() },
                {
                    type: "cold_append",
                    stream: "interval-hooks",
                    entry: { hookId, chatId, event: "skipped", reason: "previous run still running", fireIso },
                },
            ],
        }
    }

    if (hook.tracking?.skipNext) {
        dbg("IHOOK-FIRE", `hook ${hookId} skipNext; clearing and rearming`)
        return {
            stateChanges: {
                specialData: {
                    intervalHookByChatId: {
                        [chatId]: { [hookId]: { tracking: { skipNext: false } } },
                    },
                },
            },
            effects: [
                { type: "interval_hook_timer_set", chatId, hookId, rule: hook.rule, from: new Date().toISOString() },
                {
                    type: "cold_append",
                    stream: "interval-hooks",
                    entry: { hookId, chatId, event: "skipped", reason: "skipNext", fireIso },
                },
            ],
        }
    }

    const runIso = fireIso ?? new Date().toISOString()
    dbg("IHOOK-FIRE", `firing ${hookId} as run ${runIso}`)
    return {
        stateChanges: {
            specialData: {
                intervalHookByChatId: {
                    [chatId]: {
                        [hookId]: {
                            currentRun: { runIso, startedAt: new Date().toISOString() },
                        },
                    },
                },
            },
        },
        effects: [
            { type: "interval_hook_run", chatId, hookId, runIso, timeoutMs: hook.timeoutMs ?? undefined },
            {
                type: "cold_append",
                stream: "interval-hooks",
                entry: { hookId, chatId, event: "run_started", runIso },
            },
        ],
    }
}
