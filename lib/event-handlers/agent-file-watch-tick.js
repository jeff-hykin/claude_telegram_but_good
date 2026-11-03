// ---------------------------------------------------------------------------
// agent_file_watch_result handler.
//
// Fired when a Deno.watchFs watcher detects a change, times out, or
// errors. Delivers the agent's message as a channel event.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { deliverOrRefresh } = await versionedImport("../stale-chats.js", import.meta)

export default function handle(event, core) {
    const { sessionId, watchId, filePath, message, status, changeKind } = event

    const session = core.chatSessions?.[sessionId]
    if (!session?._conn) {
        dbg("FILE-WATCH", `session ${sessionId} gone — dropping ${watchId}`)
        return null
    }

    if (session.cancelledTimers?.[watchId]) {
        dbg("FILE-WATCH", `${watchId} cancelled — skipping result`)
        return null
    }

    dbg("FILE-WATCH", `${watchId} result: ${status} (${changeKind ?? "n/a"}) on ${filePath}`)

    const { stateChanges, effects } = deliverOrRefresh(core, sessionId, message, { source: "file_watch", watchId, filePath, status, changeKind })
    return { stateChanges, effects }
}
