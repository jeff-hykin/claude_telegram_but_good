// ---------------------------------------------------------------------------
// Pure helper: session-removal state patch.
//
// Three different events all end up saying "this session is gone":
//   - session_unregister (clean shim shutdown)
//   - ipc_connection_closed (shim crashed or socket EOF)
//   - session_force_close (graceful-close grace period expired)
//
// They all need the same state patch: drop the session from
// `chatSessions`, and if it was the focused session, clear focus so
// the next registering session auto-focuses. This helper is the one
// place that patch is defined.
// ---------------------------------------------------------------------------

/**
 * Build the `{ chatSessions, chatState? }` patch that removes a
 * session from core state. Pure: reads `core.chatState?.focusedSessionId`
 * but does not mutate anything.
 *
 * @param {string} sessionId
 * @param {{ chatState?: { focusedSessionId?: string|null } }} core
 * @returns {{ chatSessions: object, chatState?: { focusedSessionId: null } }}
 */
export function buildRemoveSessionPatch(sessionId, core) {
    const stateChanges = {
        chatSessions: { [sessionId]: undefined },
    }
    if (core.chatState?.focusedSessionId === sessionId) {
        stateChanges.chatState = { focusedSessionId: null }
    }
    return stateChanges
}
