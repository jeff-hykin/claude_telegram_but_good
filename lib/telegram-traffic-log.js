// ---------------------------------------------------------------------------
// lib/telegram-traffic-log.js — append-only jsonl log of every Telegram
// message that crosses the bot.
//
// Redundant with cold-storage messages.jsonl (which only logs from
// chat-user.js + claude-channel.js, and only for `from: user`/`agent`
// at the handler layer). This file is the wire-layer trace and
// captures EVERY in/out send/edit/reaction regardless of which code
// path triggered it.
//
// Path: $CBG_DIR/state/telegram-traffic.jsonl
//
// All errors are logged via dbg() and swallowed — logging must never
// break the actual message flow.
// ---------------------------------------------------------------------------

import { versionedImport } from "./version.js"

const [
    { paths },
    { dbg },
] = await Promise.all([
    versionedImport("./paths.js", import.meta),
    versionedImport("./logging.js", import.meta),
])

function logFile() {
    return `${paths.STATE_DIR}/telegram-traffic.jsonl`
}

/**
 * Append one entry to the traffic log. Stamps `ts` (ISO 8601) if absent.
 *
 * Standard fields:
 *   direction: "in" | "out"
 *   kind:      "text" | "file" | "edit" | "reaction" | "callback" | "attachment"
 *   chatId, threadId, messageId, userId, username, text, filePath, caption
 *   error (string, only on outbound failure)
 *   plus any extras the caller adds.
 */
export function logTelegramTraffic(entry) {
    try {
        const stamped = entry.ts ? entry : { ts: new Date().toISOString(), ...entry }
        Deno.writeTextFileSync(logFile(), JSON.stringify(stamped) + "\n", { append: true })
    } catch (e) {
        dbg("TG-TRAFFIC", "append failed:", e instanceof Error ? e.message : String(e))
    }
}

/**
 * Best-effort extraction of a normalized inbound entry from a Grammy
 * Context. Returns null when the message can't be parsed (callbacks
 * without a message, etc.) so the caller can fall back to a minimal
 * entry.
 */
export function inboundEntryFromCtx(ctx) {
    if (!ctx) { return null }
    if (ctx.callbackQuery) {
        const cq = ctx.callbackQuery
        return {
            direction: "in",
            kind: "callback",
            chatId: cq.message?.chat?.id != null ? String(cq.message.chat.id) : null,
            threadId: cq.message?.message_thread_id ?? null,
            messageId: cq.message?.message_id != null ? String(cq.message.message_id) : null,
            userId: cq.from?.id != null ? String(cq.from.id) : null,
            username: cq.from?.username ?? null,
            data: cq.data ?? null,
        }
    }
    const msg = ctx.message
    if (!msg) { return null }
    const attachment = msg.photo
        ? { kind: "photo", count: msg.photo.length }
        : msg.document ? { kind: "document", filename: msg.document.file_name, mimeType: msg.document.mime_type, size: msg.document.file_size }
        : msg.voice    ? { kind: "voice",    duration: msg.voice.duration, size: msg.voice.file_size }
        : msg.audio    ? { kind: "audio",    title: msg.audio.title, size: msg.audio.file_size }
        : msg.video    ? { kind: "video",    duration: msg.video.duration, size: msg.video.file_size }
        : msg.video_note ? { kind: "video_note", duration: msg.video_note.duration }
        : msg.sticker  ? { kind: "sticker",  emoji: msg.sticker.emoji, setName: msg.sticker.set_name }
        : null
    return {
        direction: "in",
        kind: attachment ? "attachment" : "text",
        chatId: msg.chat?.id != null ? String(msg.chat.id) : null,
        threadId: msg.message_thread_id ?? null,
        messageId: msg.message_id != null ? String(msg.message_id) : null,
        userId: msg.from?.id != null ? String(msg.from.id) : null,
        username: msg.from?.username ?? null,
        text: msg.text ?? msg.caption ?? null,
        attachment,
        replyToMessageId: msg.reply_to_message?.message_id != null ? String(msg.reply_to_message.message_id) : null,
    }
}
