// commands/prune.js — drop zombie (disconnected) sessions from chatSessions.
//
// A session entry is "zombie metadata" when it survives in chatSessions
// without a live `_conn` — usually because the daemon persisted state
// across a restart and the shim never came back. /list labels them
// `[disconnected]`. This command removes every such entry in one shot.

import { versionedImport } from "../lib/version.js"
const { loadAccess } = await versionedImport("../lib/access.js", import.meta)
const { escapeHtml: esc } = await versionedImport("../lib/pure/html.js", import.meta)
const { replyToFromEvent, sendEffect } = await versionedImport("../lib/pure/reply-to.js", import.meta)

export const descriptions = {
    prune: "Remove all disconnected sessions from the session list",
}

export const tips = [
    "/prune clears out old [disconnected] entries from /list.",
]

export const commands = {
    prune: (event, core) => {
        if (event.chatType !== "private") {
            return { effects: [] }
        }
        const access = loadAccess()
        const senderId = String(event.userId ?? "")
        if (!access.allowFrom.includes(senderId)) {
            return { effects: [] }
        }

        const replyTo = replyToFromEvent(event, "cmd/prune")
        const sessions = core.chatSessions ?? {}
        const removal = {}
        const removed = []
        for (const [sid, s] of Object.entries(sessions)) {
            if (!s?._conn) {
                removal[sid] = undefined
                removed.push(sid)
            }
        }

        if (removed.length === 0) {
            return {
                stateChanges: {},
                effects: [sendEffect(replyTo, "No disconnected sessions to prune.", { parse_mode: "HTML" })],
            }
        }

        // If the focused session was one of the pruned ones, clear focus
        // so the next registering session auto-focuses.
        const stateChanges = { chatSessions: removal }
        const focusedId = core.chatState?.focusedSessionId
        if (focusedId && Object.prototype.hasOwnProperty.call(removal, focusedId)) {
            stateChanges.chatState = { focusedSessionId: null }
        }

        const listed = removed.map((id) => `<code>${esc(id)}</code>`).join(", ")
        return {
            stateChanges,
            effects: [
                sendEffect(replyTo, `Pruned ${removed.length} disconnected session${removed.length === 1 ? "" : "s"}: ${listed}`, { parse_mode: "HTML" }),
            ],
        }
    },
}
