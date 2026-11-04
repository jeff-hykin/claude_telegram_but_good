// ---------------------------------------------------------------------------
// lib/event-handlers/disk-guard-check.js
//
// While free space on `disk_guard_path` is under `disk_guard_min_free_gb`,
// every connected session that is mid-turn (never an idle one) gets a DISK GUARD warning on every tick
// (`disk_guard_interval_ms`), until space is back. Jeff hears once per drop
// and once when it clears. A `disk_guard_tick` (seeded from main-server.js)
// reschedules itself and asks lib/effects/disk-free.js to measure; the
// measurement comes back as `disk_guard_check` with `freeGb`.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { getDiskGuardMinFreeGb, getDiskGuardIntervalMs, getDiskGuardPath } = await versionedImport("../config-manager.js", import.meta)
const { makeReplyTo, sendEffect } = await versionedImport("../pure/reply-to.js", import.meta)

export function isMidTurn(session) {
    return session.status === "working" || (typeof session.lastToolAt === "number" && session.lastToolAt > (session.lastStopAt ?? 0))
}

export function diskGuardWarning(freeGb, minGb, path) {
    return `DISK GUARD: only ${freeGb.toFixed(1)} GB free on ${path} (need ${minGb} GB). The disk must never reach 0 — this repeats every tick until space is back. `
        + `Now: stop starting new builds/downloads, then delete the caches, builds and tmp/scratch files YOU accumulated (cargo target dirs, build dirs, venv/nix/pip/npm caches you filled, /tmp work dirs, recordings and outputs you made). `
        + `Do not delete anything you did not create. Do not reply to this message.`
}

export function handleTick(_event, _core) {
    const effects = [{ type: "set_timer", delayMs: getDiskGuardIntervalMs(), event: { type: "disk_guard_tick" } }]
    if (getDiskGuardMinFreeGb() > 0) {
        effects.push({ type: "measure_disk_free", path: getDiskGuardPath() })
    }
    return { effects }
}

export default function handle(event, core) {
    const intervalMs = getDiskGuardIntervalMs()
    const minGb = getDiskGuardMinFreeGb()
    const { freeGb, path } = event
    const effects = []
    if (minGb <= 0 || typeof freeGb !== "number") {
        return null
    }
    const wasLow = core.chatState?.diskGuardLowSince != null
    const ccChatId = core.chatState?.commandCenter?.chatId
    const tellJeff = (text) => {
        if (ccChatId) {
            effects.push(sendEffect(makeReplyTo({ chatId: ccChatId, setBy: "disk-guard" }), text))
        }
    }

    if (freeGb >= minGb) {
        if (!wasLow) {
            return null
        }
        dbg("DISK-GUARD", `clear: ${freeGb.toFixed(1)} GB free`)
        tellJeff(`Disk guard cleared: ${freeGb.toFixed(1)} GB free on ${path}.`)
        return { stateChanges: { chatState: { diskGuardLowSince: undefined } }, effects }
    }

    // only sessions mid-turn: an idle one hasn't been filling the disk, and a warning would wake it
    const sessionIds = Object.entries(core.chatSessions ?? {}).filter(([, s]) => s?._conn && isMidTurn(s)).map(([sid]) => sid)
    dbg("DISK-GUARD", `${freeGb.toFixed(1)} GB free < ${minGb} GB — warning ${sessionIds.length} sessions`)
    const content = diskGuardWarning(freeGb, minGb, path)
    for (const sessionId of sessionIds) {
        effects.push({ type: "deliver_channel_event", sessionId, content, meta: { chat_id: "cbg-internal", user: "disk-guard", source: "disk_guard" } })
    }
    if (!wasLow) {
        tellJeff(`DISK GUARD: only ${freeGb.toFixed(1)} GB free on ${path} (< ${minGb} GB). Warning all ${sessionIds.length} agents every ${Math.round(intervalMs / 1000)} s until it clears.`)
        return { stateChanges: { chatState: { diskGuardLowSince: Date.now() } }, effects }
    }
    return { effects }
}
