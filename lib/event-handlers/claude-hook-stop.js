// ---------------------------------------------------------------------------
// claude_hook_stop handler.
//
// Fired when Claude Code's Stop hook triggers (the agent finished a turn).
// Two responsibilities:
//   1. Record `lastStopAt` / `lastActive` on the session.
//   2. Nudge watchdog: if there's an unreplied-to inbound Telegram message
//      older than 45 s, inject a reminder into the worker's dtach so the
//      next turn picks it up. One nudge per pending inbound.
//
// Stop is the natural signal for "Claude just finished its turn" — using it
// avoids a separate setInterval polling loop.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)

const NUDGE_AGE_MS = 45_000
const NUDGE_TEXT = "[automated reminder] You received a Telegram message but haven't replied yet. Please call the telegram reply tool now to respond to the user."

export default function handle(event, core) {
    if (!event.sessionId) {
        dbg("HOOK-STOP", "no sessionId (claudePid unresolved) — skipping")
        return { stateChanges: {}, effects: [] }
    }

    const session = core.chatSessions?.[event.sessionId]
    if (!session) {
        dbg("HOOK-STOP", `no session found for ${event.sessionId} — skipping`)
        return { stateChanges: {}, effects: [] }
    }

    dbg("HOOK-STOP", `recording stop for ${event.sessionId} @ ${event.ts}`)

    // ── Base state patch + cold-storage entry. ────────────────────────
    const sessionPatch = {
        lastStopAt: event.ts,
        lastActive: event.ts,
    }
    const effects = [
        {
            type: "cold_append",
            stream: "hooks",
            entry: {
                ts: event.ts,
                sessionId: event.sessionId,
                claudePid: event.claudePid ?? null,
                kind: "stop",
            },
        },
    ]

    // ── Nudge watchdog. All four conditions must hold. ────────────────
    const lastInbound = session.lastInbound
    const lastOutboundAt = session.lastOutboundAt ?? 0
    const alreadyNudged = session.nudgedForInbound === true
    const inboundAge = lastInbound ? event.ts - lastInbound.ts : 0

    const shouldNudge = (
        lastInbound                              // 1. has a pending inbound
        && lastInbound.ts > lastOutboundAt        // 2. inbound newer than last reply
        && !alreadyNudged                         // 3. not already nudged
        && inboundAge > NUDGE_AGE_MS              // 4. older than 45 s
    )

    if (shouldNudge) {
        dbg(
            "HOOK-STOP",
            `nudging ${event.sessionId}: inbound ${inboundAge}ms old, no reply yet`,
        )
        effects.push({
            type: "send_text_to_claude",
            sessionId: event.sessionId,
            text: NUDGE_TEXT,
        })
        sessionPatch.nudgedForInbound = true
    }

    return {
        stateChanges: {
            chatSessions: {
                [event.sessionId]: sessionPatch,
            },
        },
        effects,
    }
}
