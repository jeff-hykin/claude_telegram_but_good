// ---------------------------------------------------------------------------
// lib/event-handlers/slow-tool-check.js
//
// The slow-tool watchdog. A session blocked inside one tool call (a Bash
// scanning a 17 GB file, say) cannot read the messages queued behind that
// turn, so from the user's side it looks dead. Claude Code has an
// affordance for exactly this — Ctrl+B moves a running Bash command to
// the background and the turn continues — but the agent never presses it
// on its own. This handler presses it for the agent.
//
// Armed by claude-hook-pre-tool-use.js via `set_timer` when a tool call
// starts (threshold = slow_tool_background_ms, per-topic overridable).
// When it fires:
//
//   - the tool already finished (session.activeTools has no entry for
//     this toolUseId — PostToolUse or Stop cleared it)  → exit silently
//   - the topic has `/auto_background off`               → exit silently
//   - the backend cannot background tools                → exit silently
//   - otherwise → `run_tool_in_background` effect (backend.runInBackground)
//     and stamp activeTools[id].backgroundedAt so nothing fires twice.
//
// What the backend does with the request is its business: the Claude
// backend sends Ctrl+B and refuses non-Bash tools with ok:false (an MCP
// call has no background mode), which is logged, not surfaced.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { backendForSession } = await versionedImport("../agent-backends/index.js", import.meta)
const { getSlowToolBackgroundMs } = await versionedImport("../config-manager.js", import.meta)
const { autoBackgroundKeyForSession, resolveAutoBackground } = await versionedImport("../pure/auto-background.js", import.meta)

/**
 * Event shape: { type: "slow_tool_check", sessionId, toolUseId, ts }
 */
export default function handle(event, core) {
    const { sessionId, toolUseId } = event
    if (!sessionId || !toolUseId) {
        dbg("SLOW-TOOL", "missing sessionId/toolUseId")
        return { stateChanges: {}, effects: [] }
    }
    const session = core.chatSessions?.[sessionId]
    if (!session) {
        dbg("SLOW-TOOL", `session ${sessionId} gone — exiting`)
        return { stateChanges: {}, effects: [] }
    }
    const tool = session.activeTools?.[toolUseId]
    if (!tool) {
        // Finished (or the turn ended) before the threshold — the common case.
        return { stateChanges: {}, effects: [] }
    }
    if (tool.backgroundedAt) {
        return { stateChanges: {}, effects: [] }
    }

    const key = autoBackgroundKeyForSession(sessionId, core)
    const setting = resolveAutoBackground(core.chatState, key, getSlowToolBackgroundMs())
    if (!setting.enabled) {
        dbg("SLOW-TOOL", `${sessionId} ${tool.toolName} still running but auto-background is off for ${key}`)
        return { stateChanges: {}, effects: [] }
    }

    const backend = backendForSession(session)
    if (!backend.capabilities.backgroundTools) {
        dbg("SLOW-TOOL", `${sessionId} ${tool.toolName} still running; ${backend.name} cannot background tools`)
        return { stateChanges: {}, effects: [] }
    }

    const now = event.ts ?? Date.now()
    const elapsedMs = now - (tool.startedAt ?? now)
    dbg("SLOW-TOOL", `${sessionId} ${tool.toolName} running ${Math.round(elapsedMs / 1000)}s — asking ${backend.name} to background it`)
    return {
        stateChanges: {
            chatSessions: {
                [sessionId]: { activeTools: { [toolUseId]: { backgroundedAt: now } } },
            },
        },
        effects: [
            { type: "run_tool_in_background", sessionId, toolUseId, toolName: tool.toolName },
        ],
    }
}
