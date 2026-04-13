// ---------------------------------------------------------------------------
// session_unregister handler.
//
// Clean-shutdown path: a shim explicitly told us it's going away. Delete the
// entry from `chatSessions`, and if it was the focused session clear focus
// so the next session_register can auto-focus.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)

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

    const stateChanges = {
        // `undefined` deletes the key under mergeSessionData semantics.
        chatSessions: { [sessionId]: undefined },
    }

    const chatState = core.chatState ?? {}
    if (chatState.focusedSessionId === sessionId) {
        dbg("SESSION-UNREG", `clearing focus (was ${sessionId})`)
        stateChanges.chatState = { focusedSessionId: null }
    }

    return {
        stateChanges,
        effects: [],
        followUpEvents: [],
    }
}
