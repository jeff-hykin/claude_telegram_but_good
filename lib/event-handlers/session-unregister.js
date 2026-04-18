// ---------------------------------------------------------------------------
// session_unregister handler.
//
// Clean-shutdown path: a shim explicitly told us it's going away. Delete the
// entry from `chatSessions`, and if it was the focused session clear focus
// so the next session_register can auto-focus.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { escapeHtml: esc } = await versionedImport("../pure/html.js", import.meta)
const { loadAccess } = await versionedImport("../access.js", import.meta)
const { buildRemoveSessionPatch } = await versionedImport("../pure/session-removal.js", import.meta)

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

    const reason = event.reason ?? "clean"
    dbg("SESSION-UNREG", `removing session ${sessionId} (reason=${reason})`)

    const effects = []

    // Check for orphaned long tasks — warn the user if this session
    // was the worker for an active task.
    const longTaskId = session.longTaskId
    if (longTaskId) {
        const byChat = core.specialData?.longTaskByChatId ?? {}
        for (const [chatId, tasks] of Object.entries(byChat)) {
            const task = tasks?.[longTaskId]
            if (task && task.state !== "cancelled" && task.state !== "certified") {
                dbg("SESSION-UNREG", `orphaned long task ${longTaskId} (state=${task.state}) — worker session ${sessionId} is gone`)

                // Resolve the topic thread for this session so the
                // warning goes to the right place.
                const cc = core.chatState?.commandCenter ?? {}
                const threadId = cc.topicMap?.[sessionId]
                const access = loadAccess()
                const notifyChatId = access.commandCenterChatId || chatId
                const options = { parse_mode: "HTML" }
                if (threadId != null) { options.message_thread_id = Number(threadId) }

                effects.push({
                    type: "send_text_to_user",
                    chatId: notifyChatId,
                    text: `⚠️ Task <code>${esc(longTaskId)}</code> (${esc(task.title ?? "untitled")}) is now orphaned — its worker session <code>${esc(sessionId)}</code> disconnected.\n\nUse /refresh to spawn a new session, then /task_resume_${esc(longTaskId)} to reassign it.`,
                    options,
                })
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
