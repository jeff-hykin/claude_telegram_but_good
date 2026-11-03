// ---------------------------------------------------------------------------
// long_run_check handler.
//
// Emitted by tui-snapshot.js on every tick (no `processes`): asks the
// `scan_long_runs` effect for a process table, which comes back as a second
// `long_run_check` carrying `processes`. That one warns each session with a
// Bash tool command past `long_run_warn_after_ms` (see lib/pure/long-runs.js
// for what counts), at most once per command and once per
// `long_run_warn_cooldown_ms` per session. `long_run_warn_after_ms: 0` turns
// it off.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { getLongRunWarnAfterMs, getLongRunWarnCooldownMs } = await versionedImport("../config-manager.js", import.meta)
const { planLongRunWarnings } = await versionedImport("../pure/long-runs.js", import.meta)
const { deliverOrRefresh } = await versionedImport("../stale-chats.js", import.meta)

export default function handle(event, core) {
    const warnAfterMs = getLongRunWarnAfterMs()
    if (warnAfterMs <= 0) {
        return null
    }
    if (!Array.isArray(event.processes)) {
        const anyClaudeSession = Object.values(core.chatSessions ?? {})
            .some((session) => session?._conn && (session.backend ?? "claude") === "claude")
        return anyClaudeSession ? { effects: [{ type: "scan_long_runs" }] } : null
    }

    const { sessionPatches, warnings } = planLongRunWarnings({
        sessions: core.chatSessions,
        processes: event.processes,
        now: event.ts ?? Date.now(),
        warnAfterMs,
        cooldownMs: getLongRunWarnCooldownMs(),
    })
    for (const { sessionId, text } of warnings) {
        dbg("LONG-RUN", `${sessionId}: ${text.slice(0, 160)}`)
    }
    if (Object.keys(sessionPatches).length === 0) {
        return null
    }
    // A warning is an automatic wake: a stale topic session is refreshed first, so the poke doesn't re-read its whole context.
    let chatState = core.chatState
    const effects = []
    for (const { sessionId, text } of warnings) {
        const delivery = deliverOrRefresh({ ...core, chatState }, sessionId, text, { source: "long_run_warning" }, { type: "send_text_to_claude", sessionId, text })
        if (delivery.refreshedTo) {
            chatState = { ...chatState, ...delivery.stateChanges.chatState }
        }
        effects.push(...delivery.effects)
    }
    return {
        stateChanges: { chatSessions: sessionPatches, ...(chatState !== core.chatState ? { chatState } : {}) },
        effects,
    }
}
