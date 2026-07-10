// lib/event-handlers/interval-hook-run-complete.js
//
// Finalize an interval-hook run:
//   - update tracking (totalRuns, lastRun*, runHistory ring buffer)
//   - clear currentRun
//   - rearm the next fire (unless deactivated)
//   - deliver to the topic's agent:
//       status "message" → deliver the returned string
//       status "error" / "timeout" → deliver the error (per design, the
//         topic agent handles hook failures, NOT a raw Telegram post)
//       status "noop" → deliver nothing

import { versionedImport } from "../version.js"
const { dbg } = await versionedImport("../logging.js", import.meta)
const { paths } = await versionedImport("../paths.js", import.meta)
const { findIntervalHook, buildTopicDeliveryAction } = await versionedImport("../interval-hook-actions.js", import.meta)

const RUN_HISTORY_MAX = 10

export default function handle(event, core) {
    const { chatId, hookId, runIso, status, result, error } = event
    const found = findIntervalHook(core.specialData, hookId)
    if (!found) {
        dbg("IHOOK-DONE", `hook ${hookId} not found; swallowing run_complete`)
        return null
    }
    const { hook } = found

    const summary = status === "message"
        ? String(result ?? "").slice(0, 300)
        : String(error ?? "").slice(0, 300)

    const prevHistory = hook.tracking?.runHistory ?? []
    const newEntry = { runIso, status, summary, at: new Date().toISOString() }
    const nextHistory = [...prevHistory, newEntry].slice(-RUN_HISTORY_MAX)
    const totalRuns = (hook.tracking?.totalRuns ?? 0) + 1

    // Build the delivery Action (may resurrect the topic session).
    let delivery = { effects: [] }
    if (status === "message" && result) {
        const content = `[interval hook ${hookId} → topic ${hook.topic}]\n${result}`
        delivery = buildTopicDeliveryAction(core, hook.topic, content, {
            source: "interval_hook",
            user: `hook:${hookId}`,
        })
    } else if (status === "error" || status === "timeout") {
        const content = `⚠️ Interval hook ${hookId} (${hook.topic}) ${status === "timeout" ? "timed out" : "errored"} on run ${runIso}:\n\n${error ?? "(no detail)"}\n\nThe hook JS is at ${paths.intervalHookFile(hookId)}. Fix it or deactivate it (/interval_hook_off_${hookId}).`
        delivery = buildTopicDeliveryAction(core, hook.topic, content, {
            source: "interval_hook_error",
            user: `hook:${hookId}`,
        })
    }

    const effects = [...(delivery.effects ?? [])]

    effects.push({
        type: "cold_append",
        stream: "interval-hooks",
        entry: { hookId, chatId, event: "run_complete", runIso, status },
    })

    // Rearm unless the hook was deactivated (e.g. mid-run).
    if (hook.active) {
        effects.push({
            type: "interval_hook_timer_set",
            chatId, hookId, rule: hook.rule,
            from: new Date().toISOString(),
        })
    }

    dbg("IHOOK-DONE", `${hookId} run ${runIso} → ${status}`)

    // Merge our specialData tracking patch with the delivery's chatState
    // patch (resurrection binds the topic + queues the message).
    const stateChanges = {
        specialData: {
            intervalHookByChatId: {
                [chatId]: {
                    [hookId]: {
                        currentRun: undefined,
                        tracking: {
                            totalRuns,
                            lastRunAt: new Date().toISOString(),
                            lastRunStatus: status,
                            lastResult: status === "message" ? String(result ?? "").slice(0, 500) : null,
                            runHistory: nextHistory,
                        },
                    },
                },
            },
        },
    }
    if (delivery.stateChanges?.chatState) {
        stateChanges.chatState = delivery.stateChanges.chatState
    }

    return { stateChanges, effects }
}
