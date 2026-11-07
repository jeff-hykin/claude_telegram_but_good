// ---------------------------------------------------------------------------
// session_unregister handler.
//
// Clean-shutdown path: a shim explicitly told us it's going away. Delete the
// entry from `chatSessions`, and if it was the focused session clear focus
// so the next session_register can auto-focus.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { escapeMarkdown: esc } = await versionedImport("../pure/markdown.js", import.meta)
const { loadAccess } = await versionedImport("../access.js", import.meta)
const { buildRemoveSessionPatch } = await versionedImport("../pure/session-removal.js", import.meta)
const { replyToForSession, sendEffect } = await versionedImport("../pure/reply-to.js", import.meta)

export default function handle(event, core) {
    const sessionId = event.sessionId
    if (typeof sessionId !== "string" || sessionId.length === 0) {
        dbg("SESSION-UNREG", "invalid event, missing sessionId")
        return null
    }

    const sessions = core.chatSessions ?? {}
    const session = sessions[sessionId]
    if (!session) {
        dbg("SESSION-UNREG", `no-op — unknown session: ${sessionId}`)
        return null
    }

    // A nested `claude` launched from inside a session's own Bash call inherits
    // CBG_SESSION_ID, so its shim registers under the same id and steals _conn.
    // When that short-lived shim exits cleanly we must not delete the entry the
    // original, still-connected shim is using — otherwise the live session goes
    // "disconnected" forever while its process keeps running. ipc-connection-
    // closed.js already makes the same ownership check on the dirty path.
    if (event._conn && session._conn && session._conn !== event._conn) {
        dbg("SESSION-UNREG", `no-op — ${sessionId} is owned by a different live connection (duplicate shim exited)`)
        return null
    }

    const reason = event.reason ?? "clean"
    dbg("SESSION-UNREG", `removing session ${sessionId} (reason=${reason})`)

    const effects = [
        { type: "fail_inbox_waiters_for_session", sessionId, reason: `unregistered (${reason})` },
    ]

    // Check for orphaned long tasks — warn the user if this session
    // was the worker for an active task.
    const longTaskId = session.longTaskId
    if (longTaskId) {
        const byChat = core.specialData?.longTaskByChatId ?? {}
        for (const [chatId, tasks] of Object.entries(byChat)) {
            const task = tasks?.[longTaskId]
            if (task && task.state !== "cancelled" && task.state !== "certified") {
                dbg("SESSION-UNREG", `orphaned long task ${longTaskId} (state=${task.state}) — worker session ${sessionId} is gone`)

                const access = loadAccess()
                const replyTo = replyToForSession(sessionId, core, "session-unreg/orphan", access.commandCenterChatId || chatId)
                effects.push(sendEffect(
                    replyTo,
                    `⚠️ Task ${longTaskId} (${task.title ?? "untitled"}) is now orphaned — its worker session ${sessionId} disconnected.\n\nUse /refresh to spawn a new session, then /task_resume_${longTaskId} to reassign it.`,
                    {},
                ))
                break
            }
        }
    }

    return {
        stateChanges: buildRemoveSessionPatch(sessionId, core),
        effects,
        followUpEvents: [],
    }
}
