// ---------------------------------------------------------------------------
// session_unregister handler.
//
// Clean-shutdown path: a shim explicitly told us it's going away. Delete the
// entry from `chatSessions`, and if it was the focused session clear focus
// so the next session_register can auto-focus.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { buildRemoveSessionPatch } = await versionedImport("../pure/session-removal.js", import.meta)

export default function handle(event, core) {
    const sessionId = event.sessionId
    if (typeof sessionId !== "string" || sessionId.length === 0) {
        dbg("SESSION-UNREG", "invalid event, missing sessionId")
        return null
    }

    const sessions = core.chatSessions ?? {}
    if (!sessions[sessionId]) {
        dbg("SESSION-UNREG", `no-op — unknown session: ${sessionId}`)
        return null
    }

    const reason = event.reason ?? "clean"
    dbg("SESSION-UNREG", `removing session ${sessionId} (reason=${reason})`)

    return {
        stateChanges: buildRemoveSessionPatch(sessionId, core),
        effects: [],
        followUpEvents: [],
    }
}
