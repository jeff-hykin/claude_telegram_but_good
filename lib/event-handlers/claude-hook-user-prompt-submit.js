// ---------------------------------------------------------------------------
// claude_hook_user_prompt_submit handler.
//
// hook.js forwards only Claude Code's own "background command finished"
// notice (<task-notification>), which never passes through cbg otherwise.
// If the session is a stale topic session, the notice is blocked and the
// topic refreshed, so the fresh session gets the notice instead of the stale
// one re-paying its whole context. hook.js waits on the answer, so we ALWAYS
// respond, and the decision goes first.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { deliverOrRefresh } = await versionedImport("../stale-chats.js", import.meta)

const NOTICE_PATTERN = /^\s*<task-notification>/

export default function handle(event, core) {
    const respond = (message) => ({ type: "ipc_respond", conn: event._conn, closeAfter: true, message })
    const pass = { stateChanges: {}, effects: [respond({ type: "hook_decision", block: false })] }

    const session = event.sessionId ? core.chatSessions?.[event.sessionId] : null
    if (!session || !NOTICE_PATTERN.test(event.prompt ?? "")) {
        return pass
    }
    const content = `A background command started by the previous session of this topic (${event.sessionId}) has finished. Claude Code's notice:\n\n${event.prompt}`
    const result = deliverOrRefresh(core, event.sessionId, content, { source: "background_task_finished" }, null)
    if (!result.refreshedTo) {
        return pass
    }
    dbg("HOOK-UPS", `${event.sessionId}: background-task notice blocked, handed to ${result.refreshedTo}`)
    return {
        stateChanges: result.stateChanges,
        effects: [
            respond({ type: "hook_decision", block: true, reason: `cbg: stale session, refreshed to ${result.refreshedTo}, which gets this notice` }),
            ...result.effects,
        ],
    }
}
