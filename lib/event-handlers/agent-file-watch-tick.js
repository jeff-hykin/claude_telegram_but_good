// ---------------------------------------------------------------------------
// agent_file_watch_tick handler.
//
// Polls a file for changes (mtime or existence). When a change is
// detected, delivers the agent's message as a channel event (one-shot).
// Times out after the configured duration.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)

const POLL_MS = 2000

export default function handle(event, core) {
    const { sessionId, watchId, filePath, message, initialMtime, startedAt, timeoutMs } = event

    const session = core.chatSessions?.[sessionId]
    if (!session?._conn) {
        dbg("FILE-WATCH", `session ${sessionId} gone — dropping ${watchId}`)
        return null
    }

    // Check if cancelled.
    if (session.cancelledTimers?.[watchId]) {
        dbg("FILE-WATCH", `${watchId} cancelled — stopping`)
        return null
    }

    // Check timeout.
    if (Date.now() - startedAt > timeoutMs) {
        dbg("FILE-WATCH", `${watchId} timed out after ${timeoutMs}ms`)
        return {
            stateChanges: {},
            effects: [{
                type: "deliver_channel_event",
                sessionId,
                content: `[file watch ${watchId} timed out after ${Math.round(timeoutMs / 1000)}s — no changes detected on ${filePath}]`,
                meta: { source: "file_watch", watchId, status: "timeout" },
            }],
        }
    }

    // Check for changes.
    let currentMtime = null
    let exists = false
    try {
        const stat = Deno.statSync(filePath)
        currentMtime = stat.mtime?.getTime() ?? null
        exists = true
    } catch {
        // File doesn't exist.
    }

    const changed =
        (initialMtime === null && exists) ||           // created
        (initialMtime !== null && !exists) ||           // deleted
        (initialMtime !== null && currentMtime !== null && currentMtime !== initialMtime)  // modified

    if (changed) {
        dbg("FILE-WATCH", `${watchId} detected change on ${filePath}`)
        return {
            stateChanges: {},
            effects: [{
                type: "deliver_channel_event",
                sessionId,
                content: message,
                meta: { source: "file_watch", watchId, filePath, status: "changed" },
            }],
        }
    }

    // No change — reschedule.
    return {
        stateChanges: {},
        effects: [{
            type: "set_timer",
            delayMs: POLL_MS,
            event: { ...event, ts: Date.now() },
        }],
    }
}
