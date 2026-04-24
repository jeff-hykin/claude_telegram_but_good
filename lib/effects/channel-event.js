/**
 * Deliver a channel_event notification to a worker session's shim via IPC.
 *
 * effect shape: { type: "deliver_channel_event", sessionId, content, meta }
 *
 * The shim receives this over its long-lived IPC conn and converts it
 * into an MCP channel/message notification so Claude sees it as user input.
 *
 * Also writes the message to the session's inbox for persistent history.
 * If the meta includes a topic name, writes to the topic inbox too.
 */

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { encodeIpcFrame } = await versionedImport("../ipc.js", import.meta)
const { appendInboxMessage, topicInboxAddress } = await versionedImport("../inbox.js", import.meta)

export async function deliverChannelEvent(effect, core) {
    const { sessionId, content, meta } = effect
    const session = core.chatSessions?.[sessionId]

    // Build the inbox message from the effect metadata
    const inboxMsg = {
        ts: Date.now(),
        from: meta?.source === "tell_session"
            ? { type: "session", sessionId: meta.fromSession, topicName: meta.fromTopic }
            : meta?.source === "cli_tell"
            ? { type: "cli", inboxId: meta.fromInbox ?? "cli" }
            : { type: "telegram", chatId: meta?.chat_id, messageId: meta?.message_id },
        text: String(content ?? ""),
        meta,
    }

    // Write to session inbox (always, even if session is disconnected)
    if (sessionId) {
        appendInboxMessage(sessionId, inboxMsg)
    }

    // Write to topic inbox if we can determine the topic
    const cc = core.chatState?.commandCenter ?? {}
    const threadId = cc.topicMap?.[sessionId] ?? null
    const topicName = threadId ? (cc.topicNames?.[threadId] ?? null) : null
    if (topicName) {
        appendInboxMessage(topicInboxAddress(topicName), inboxMsg)
    }

    if (!session?._conn) {
        dbg("CHANNEL-EVENT", `no _conn for session ${sessionId} (inbox written)`)
        return
    }
    try {
        await session._conn.write(encodeIpcFrame({ type: "channel_event", content, meta }))
        dbg("CHANNEL-EVENT", `delivered to ${sessionId} (${String(content).length} chars)`)
    } catch (e) {
        dbg("CHANNEL-EVENT", `delivery failed for ${sessionId}:`, e)
    }
}
