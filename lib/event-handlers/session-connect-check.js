// ---------------------------------------------------------------------------
// session_connect_check handler.
//
// Fired `session_connect_timeout_ms` after spawn_dtach_session. A session
// still missing from chatSessions by then never connected its Telegram shim
// (a shim that crashes on startup leaves claude running with no way to reach
// it — 2026-10-26, Deno 2.7+). Everything sent to its topic would queue until
// "queue full". So: kill it and respawn the topic, carrying its queued
// messages. A respawn that also fails to connect is killed and reported
// instead of respawned again; the next message to the topic retries.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { escapeMarkdown: esc } = await versionedImport("../pure/markdown.js", import.meta)
const { sendEffect, makeReplyTo } = await versionedImport("../pure/reply-to.js", import.meta)
const { respawnTopicSession } = await versionedImport("../stale-chats.js", import.meta)
const { getSessionConnectTimeoutMs } = await versionedImport("../config-manager.js", import.meta)

export default function handle(event, core) {
    const { sessionId } = event
    const connectAttempt = event.connectAttempt ?? 0
    if (core.chatSessions?.[sessionId]) {
        return null
    }

    const cc = core.chatState?.commandCenter ?? {}
    const threadKey = cc.topicMap?.[sessionId] != null ? String(cc.topicMap[sessionId]) : null
    if (!threadKey || cc.threadMap?.[threadKey] !== sessionId) {
        // Not a topic's session (worker, DM, or already replaced) — nothing routes to it.
        dbg("CONNECT-CHECK", `${sessionId} never connected but isn't a topic's session — leaving it`)
        return null
    }

    const minutes = Math.round(getSessionConnectTimeoutMs() / 60_000)
    const replyTo = makeReplyTo({ chatId: String(cc.chatId), threadId: threadKey, setBy: "session-connect-check" })
    const kill = { type: "kill_dtach_session", sessionId }

    if (connectAttempt >= 1) {
        dbg("CONNECT-CHECK", `${sessionId} never connected (respawn ${connectAttempt}) — killing, not respawning again`)
        return {
            effects: [
                kill,
                sendEffect(replyTo, `Session \`${esc(sessionId)}\` also never connected to Telegram after ${minutes} min, so I killed it. Your next message here starts a new one. If that fails too, the shim is crashing: run \`deno run -A ~/.local/share/cbg/repo/event-generators/mcp-server/mcp-shim.js\``, { parse_mode: "Markdown" }),
            ],
        }
    }

    dbg("CONNECT-CHECK", `${sessionId} never connected after ${minutes} min — respawning its topic`)
    const refresh = respawnTopicSession(core, { threadKey, deadSessionId: sessionId, connectAttempt: connectAttempt + 1 })
    return {
        stateChanges: refresh.stateChanges,
        effects: [
            kill,
            ...refresh.effects,
            sendEffect(replyTo, `Session \`${esc(sessionId)}\` never connected to Telegram after ${minutes} min — killed it and started \`${esc(refresh.sessionId)}\`${refresh.note}`, { parse_mode: "Markdown" }),
        ],
    }
}
