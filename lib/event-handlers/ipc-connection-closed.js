// ---------------------------------------------------------------------------
// ipc_connection_closed handler.
//
// Fires when a per-connection read loop exits (EOF or read error). If the
// closed conn belongs to a registered session, we treat it as a crash-style
// unregister — drop the session and clear focus if needed. Otherwise it was
// probably a one-shot CLI or hook connection, and we just log.
//
// No effects: the connection is already gone, there's no one to reply to.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { buildRemoveSessionPatch } = await versionedImport("../pure/session-removal.js", import.meta)

export default function handle(event, core) {
    const closedConn = event._conn
    if (!closedConn) {
        dbg("IPC-CLOSED", "no-op — event has no _conn")
        return null
    }

    // Always drop any parked ask-sync waiters tied to this conn, regardless
    // of whether it was a session conn or a one-shot CLI. The effect is a
    // no-op if no waiter matches.
    const clearWaiter = { type: "clear_inbox_waiter", conn: closedConn }

    const sessions = core.chatSessions ?? {}
    let foundId = null
    for (const [sid, s] of Object.entries(sessions)) {
        if (s && s._conn === closedConn) {
            foundId = sid
            break
        }
    }

    if (!foundId) {
        dbg("IPC-CLOSED", "connection not tied to any session (one-shot CLI/hook?)")
        return { stateChanges: {}, effects: [clearWaiter], followUpEvents: [] }
    }

    dbg("IPC-CLOSED", `conn belonged to session ${foundId} — removing`)

    return {
        stateChanges: buildRemoveSessionPatch(foundId, core),
        effects: [clearWaiter],
        followUpEvents: [],
    }
}
