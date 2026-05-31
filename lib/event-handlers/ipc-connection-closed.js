// ---------------------------------------------------------------------------
// ipc_connection_closed handler.
//
// Fires when a per-connection read loop exits (EOF or read error). If the
// closed conn belongs to a registered session, we soft-disconnect it:
// null _conn but keep the entry so the shim can reconnect and messages
// queue for it. One-shot CLI/hook connections are just logged.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { buildDisconnectPatch } = await versionedImport("../pure/session-removal.js", import.meta)

export default function handle(event, core) {
    const closedConn = event._conn
    if (!closedConn) {
        dbg("IPC-CLOSED", "no-op — event has no _conn")
        return null
    }

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

    dbg("IPC-CLOSED", `conn belonged to session ${foundId} — soft-disconnecting (will reconnect)`)

    return {
        stateChanges: buildDisconnectPatch(foundId),
        effects: [clearWaiter],
        followUpEvents: [],
    }
}
