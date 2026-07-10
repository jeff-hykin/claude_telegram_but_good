// lib/event-handlers/interval-hook-stuck-watchdog.js
//
// Periodic watchdog that detects interval-hook runs stuck with a
// lingering currentRun (e.g. the daemon stayed up but the run coroutine
// silently died) and synthesizes an interval_hook_run_complete (error)
// to clear currentRun and rearm the timer. Self-schedules every
// SCAN_INTERVAL_MS; the initial tick is seeded from main-server.js.

import { versionedImport } from "../version.js"
const { dbg } = await versionedImport("../logging.js", import.meta)

const SCAN_INTERVAL_MS = 5 * 60 * 1000

// Hook runs are meant to be fast (seconds). If a currentRun has lingered
// this long, something went wrong — reap it.
const STUCK_THRESHOLD_MS = 15 * 60 * 1000

export default function handle(_event, core) {
    const effects = [
        { type: "set_timer", delayMs: SCAN_INTERVAL_MS, event: { type: "interval_hook_stuck_watchdog" } },
    ]
    const followUpEvents = []

    const byChat = core?.specialData?.intervalHookByChatId ?? {}
    const now = Date.now()
    let reaped = 0

    for (const [chatId, hooks] of Object.entries(byChat)) {
        for (const [hookId, hook] of Object.entries(hooks ?? {})) {
            if (!hook || typeof hook !== "object") { continue }
            if (!hook.currentRun) { continue }
            const startedAt = hook.currentRun.startedAt
            if (!startedAt) { continue }
            const startedMs = Date.parse(startedAt)
            if (Number.isNaN(startedMs)) { continue }
            if (now - startedMs < STUCK_THRESHOLD_MS) { continue }

            const ageMin = Math.round((now - startedMs) / 60_000)
            dbg("IHOOK-WATCHDOG", `${hookId} stuck for ${ageMin}min — reaping`)
            followUpEvents.push({
                type: "interval_hook_run_complete",
                chatId, hookId,
                runIso: hook.currentRun.runIso,
                status: "error",
                error: `Watchdog reaped run after ${ageMin}min — run coroutine stalled without completing.`,
            })
            reaped++
        }
    }

    if (reaped > 0) { dbg("IHOOK-WATCHDOG", `reaped ${reaped} stuck run(s) this tick`) }
    return { effects, followUpEvents }
}
