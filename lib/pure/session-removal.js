// ---------------------------------------------------------------------------
// Pure helpers: session-removal / session-disconnect state patches.
//
// Two flavours:
//   - buildRemoveSessionPatch  — full removal (clean shutdown via
//     session_unregister). Deletes the entry from chatSessions.
//   - buildDisconnectPatch     — soft disconnect (IPC connection dropped,
//     e.g. macOS sleep). Nulls `_conn` so message routing can detect
//     the session is offline, but keeps the entry alive so the shim can
//     reconnect and re-register with the same ID.
// ---------------------------------------------------------------------------

/**
 * Full removal — used for clean unregister only.
 */
export function buildRemoveSessionPatch(sessionId, core) {
    const stateChanges = {
        chatSessions: { [sessionId]: undefined },
    }
    if (core.chatState?.focusedSessionId === sessionId) {
        stateChanges.chatState = { focusedSessionId: null }
    }
    // A topic outlives its process. Keep the backend before removing the
    // only session entry that records it, including pre-migration sessions.
    const session = core.chatSessions?.[sessionId]
    const cc = core.chatState?.commandCenter ?? {}
    const thread = Object.entries(cc.threadMap ?? {}).find(([, id]) => id === sessionId)?.[0]
    if (session && thread) {
        stateChanges.chatState = {
            ...(stateChanges.chatState ?? {}),
            commandCenter: { ...cc, topicBackends: { ...(cc.topicBackends ?? {}), [thread]: session.backend ?? "claude" } },
        }
    }
    for (const [chatId, binding] of Object.entries(core.chatState?.groupChatSessions ?? {})) {
        if (session && binding.sessionId === sessionId) {
            stateChanges.chatState = {
                ...(stateChanges.chatState ?? {}),
                groupChatSessions: { [chatId]: { ...binding, backend: session.backend ?? "claude" } },
            }
        }
    }
    return stateChanges
}

/**
 * Soft disconnect — keeps session entry alive so the shim can reconnect.
 * Does NOT clear focusedSessionId so message routing stays intact;
 * callers queue messages for the disconnected session until it comes back.
 */
export function buildDisconnectPatch(sessionId) {
    return {
        chatSessions: {
            [sessionId]: {
                _conn: undefined,
                disconnectedAt: Date.now(),
            },
        },
    }
}
