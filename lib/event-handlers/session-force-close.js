// ---------------------------------------------------------------------------
// session_force_close handler.
//
// Fired by the `set_timer` effect scheduled from handleClose in
// chat-user.js. The flow:
//
//   user → /close_<id> → handleClose:
//     - emit send_text_to_claude text="/exit"   (graceful path)
//     - emit set_timer 15s → { type: "session_force_close", sessionId }
//
// Fifteen seconds later this handler runs. If the session is still in
// chatSessions the graceful `/exit` didn't land (Claude was mid-turn, or
// the TUI ignored it), so we SIGTERM the pid and drop the session from
// state. If the session is already gone (shim unregistered cleanly), the
// timer is a no-op.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { escapeHtml: esc } = await versionedImport("../pure/html.js", import.meta)
const { buildRemoveSessionPatch } = await versionedImport("../pure/session-removal.js", import.meta)

export default function handle(event, core) {
    const sessionId = event.sessionId
    const requestChatId = event.requestChatId ?? null
    if (typeof sessionId !== "string" || sessionId.length === 0) {
        dbg("SESSION-FORCE-CLOSE", "invalid event, missing sessionId")
        return null
    }

    const session = core.chatSessions?.[sessionId]
    if (!session) {
        dbg("SESSION-FORCE-CLOSE", `no-op — session ${sessionId} already gone`)
        return null
    }

    dbg("SESSION-FORCE-CLOSE", `forcing close of ${sessionId} (pid=${session.pid})`)

    const effects = []
    if (typeof session.pid === "number") {
        effects.push({ type: "signal_process", pid: session.pid, signal: "SIGTERM" })
    }
    if (requestChatId) {
        effects.push({
            type: "send_text_to_user",
            chatId: requestChatId,
            text: `Session <code>${esc(sessionId)}</code> didn't exit cleanly — sent SIGTERM.`,
            options: { parse_mode: "HTML" },
        })
    }

    return {
        stateChanges: buildRemoveSessionPatch(sessionId, core),
        effects,
        followUpEvents: [],
    }
}
