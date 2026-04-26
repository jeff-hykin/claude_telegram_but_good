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
const { paths } = await versionedImport("../paths.js", import.meta)

// How often to nudge a topic-bound agent to update its memory file.
// Throttled per topic — one reminder per topic per interval, regardless of
// how many channel events flow through. Tweak here if it feels too noisy
// or too sparse.
const MEMORY_REMINDER_INTERVAL_MS = 60 * 60 * 1000  // 1 hour

function buildMemoryReminder(topicName) {
    const path = paths.topicMemoryFile(topicName)
    return `\n\n<system-reminder>\nDon't forget to update your topic memory file at ${path}. It persists across session refreshes — keep it concise: what's being worked on, current state, key decisions, next steps.\n</system-reminder>`
}

export async function deliverChannelEvent(effect, core) {
    const { sessionId, content, meta } = effect
    const session = core.chatSessions?.[sessionId]

    // Resolve the topic for this session. Used both for inbox routing and
    // for the periodic memory-file reminder below.
    const cc = core.chatState?.commandCenter ?? {}
    const threadId = cc.topicMap?.[sessionId] ?? null
    const topicName = threadId ? (cc.topicNames?.[threadId] ?? null) : null

    // Throttled per-topic memory-file reminder. Appended to whatever
    // content we were going to deliver, so the agent sees it inline with
    // their next inbound message rather than as a separate event.
    let augmentedContent = String(content ?? "")
    let reminderPatch = null
    if (topicName) {
        const lastAt = cc.memoryReminderLastAt?.[topicName] ?? 0
        const now = Date.now()
        if (now - lastAt > MEMORY_REMINDER_INTERVAL_MS) {
            augmentedContent += buildMemoryReminder(topicName)
            reminderPatch = {
                chatState: { commandCenter: { memoryReminderLastAt: { [topicName]: now } } },
            }
            dbg("CHANNEL-EVENT", `appended memory reminder for topic ${topicName}`)
        }
    }

    // Build the inbox message from the effect metadata. Use the augmented
    // content so the on-disk inbox matches what the agent actually saw.
    const inboxMsg = {
        ts: Date.now(),
        from: meta?.source === "tell_session"
            ? { type: "session", sessionId: meta.fromSession, topicName: meta.fromTopic }
            : meta?.source === "cli_tell"
            ? { type: "cli", inboxId: meta.fromInbox ?? "cli" }
            : { type: "telegram", chatId: meta?.chat_id, messageId: meta?.message_id },
        text: augmentedContent,
        meta,
    }

    // Write to session inbox (always, even if session is disconnected).
    // Awaited so an unhandled rejection or daemon crash mid-flight can't
    // silently drop the on-disk record.
    if (sessionId) {
        await appendInboxMessage(sessionId, inboxMsg)
    }

    if (topicName) {
        await appendInboxMessage(topicInboxAddress(topicName), inboxMsg)
    }

    if (!session?._conn) {
        dbg("CHANNEL-EVENT", `no _conn for session ${sessionId} (inbox written)`)
        return reminderPatch ? { stateChanges: reminderPatch } : undefined
    }
    // Claude Code wraps the notification's meta into a <channel chat_id="..."
    // user="..." ts="..."> tag. Empirically, including non-standard fields
    // like {fromCli: true, fromInbox: null} in meta triggers Claude Code to
    // SIGTERM the MCP shim ~2s after delivery — likely a serialization /
    // attribute-rendering crash on the boolean/null types. Build a meta
    // payload containing ONLY the fields the official telegram plugin sends
    // (chat_id, message_id, user, user_id, ts, plus the optional image_path
    // and attachment_*); strip everything else.
    const safeMeta = {
        chat_id: String(meta?.chat_id ?? "cbg-internal"),
        message_id: String(meta?.message_id ?? `cbg-${Date.now()}`),
        user: String(meta?.user ?? meta?.fromInbox ?? meta?.source ?? "cbg"),
        user_id: String(meta?.user_id ?? "cbg"),
        ts: String(meta?.ts ?? new Date().toISOString()),
    }
    if (meta?.image_path) { safeMeta.image_path = String(meta.image_path) }
    if (meta?.attachment_kind)    { safeMeta.attachment_kind    = String(meta.attachment_kind) }
    if (meta?.attachment_file_id) { safeMeta.attachment_file_id = String(meta.attachment_file_id) }
    if (meta?.attachment_size)    { safeMeta.attachment_size    = String(meta.attachment_size) }
    if (meta?.attachment_mime)    { safeMeta.attachment_mime    = String(meta.attachment_mime) }
    if (meta?.attachment_name)    { safeMeta.attachment_name    = String(meta.attachment_name) }
    try {
        await session._conn.write(encodeIpcFrame({ type: "channel_event", content: augmentedContent, meta: safeMeta }))
        dbg("CHANNEL-EVENT", `delivered to ${sessionId} (${augmentedContent.length} chars, meta keys=[${Object.keys(safeMeta).join(",")}])`)
    } catch (e) {
        dbg("CHANNEL-EVENT", `delivery failed for ${sessionId}:`, e)
    }

    return reminderPatch ? { stateChanges: reminderPatch } : undefined
}
