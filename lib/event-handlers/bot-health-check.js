// ---------------------------------------------------------------------------
// lib/event-handlers/bot-health-check.js
//
// Periodic watchdog for the Grammy polling loop. Detects two failure modes:
//
//   1. Polling loop exited (pollingDied flag) — Grammy's long-poll promise
//      resolved or rejected after startup. Immediate restart.
//
//   2. Silent death — no messages received for BOT_SILENT_THRESHOLD_MS
//      while the bot believes it's still running. This catches edge cases
//      where Grammy's internal polling stops making requests without
//      raising an error (e.g. after laptop sleep/wake, network changes).
//
// Self-schedules via set_timer every CHECK_INTERVAL_MS. The initial tick
// is enqueued from main-server.js at startup.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { paths } = await versionedImport("../paths.js", import.meta)

/**
 * How often the watchdog runs (ms). 60s keeps overhead trivial while
 * catching a dead bot within ~1 minute.
 */
const CHECK_INTERVAL_MS = 60_000

/**
 * If no Grammy message has been received for this long AND the bot
 * thinks it's started, trigger a restart. 10 minutes is generous
 * enough to avoid false positives during quiet hours — even an idle
 * bot should receive Telegram service messages (member joins, etc.)
 * or the user's own commands within this window. The real signal is
 * the pollingDied flag; this is the safety net for the case where
 * polling silently wedges without exiting.
 */
const BOT_SILENT_THRESHOLD_MS = 10 * 60 * 1000

/**
 * Find the "Cbg" topic threadId from commandCenter.topicNames so
 * health alerts route to the Cbg topic instead of General.
 */
function findCbgThreadId(cc) {
    const topicNames = cc?.topicNames
    if (!topicNames) { return undefined }
    for (const [threadId, name] of Object.entries(topicNames)) {
        if (name === "Cbg") { return Number(threadId) }
    }
    return undefined
}

export default async function handleBotHealthCheck(_event, core) {
    const effects = []

    // Always re-schedule the next tick.
    effects.push({
        type: "set_timer",
        delayMs: CHECK_INTERVAL_MS,
        event: { type: "bot_health_check" },
    })

    const bot = core.bot

    // Connectivity heartbeat for the launchd watchdog (see
    // event-generators/watchdog/connectivity-watchdog.js). This used to be
    // written only when an allowed sender messaged the bot, which made a
    // quiet night indistinguishable from a dead daemon — the watchdog
    // restarted a perfectly healthy cbg roughly hourly, and since a restart
    // produces no message, it looped. An API round-trip proves the link
    // independently of whether anyone is talking. With no adapter at all
    // there is nothing a restart could fix, so that counts as alive too.
    const reachable = bot?.ping ? await bot.ping() : true
    if (reachable) {
        effects.push({
            type: "write_file",
            path: paths.LAST_CONNECTIVITY_FILE,
            content: String(Date.now()),
        })
    } else {
        dbg("BOT-HEALTH", "ping failed — connectivity heartbeat not refreshed")
    }

    if (!bot || typeof bot.pollingHealth === "undefined") {
        // No bot (IPC-only mode) or not a TelegramBot — nothing to watch.
        return { effects }
    }

    const health = bot.pollingHealth

    // Case 1: polling loop explicitly exited.
    if (health.pollingDied) {
        dbg("BOT-HEALTH", `polling loop died — attempting restart (restart #${health.restartCount + 1})`)
        try {
            const ok = await bot.restart()
            if (ok) {
                dbg("BOT-HEALTH", "restart succeeded")
            } else {
                dbg("BOT-HEALTH", "restart failed — will retry next tick")
            }
        } catch (e) {
            dbg("BOT-HEALTH", "restart threw:", e)
        }
        return { effects }
    }

    // Case 2: silent death — bot thinks it's running but hasn't
    // received any message in a long time.
    if (
        health.started &&
        health.lastMessageAt > 0 &&
        health.msSinceLastMessage > BOT_SILENT_THRESHOLD_MS
    ) {
        const silentMin = Math.round(health.msSinceLastMessage / 60_000)
        dbg("BOT-HEALTH", `no messages received in ${silentMin}min — attempting restart`)
        try {
            const ok = await bot.restart()
            if (ok) {
                dbg("BOT-HEALTH", "silent-death restart succeeded")
            } else {
                dbg("BOT-HEALTH", "silent-death restart failed — will retry next tick")
            }
        } catch (e) {
            dbg("BOT-HEALTH", "silent-death restart threw:", e)
        }
    }

    return { effects }
}
