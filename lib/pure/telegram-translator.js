/**
 * Telegram message translator.
 *
 * Pure function: converts a Grammy Context into structured events for
 * the main event loop. Never imports anything, never logs, never mutates
 * the context. Errors thrown inside are the caller's responsibility —
 * main-server.js wraps the call in its own try/catch so it can log via
 * `dbg("TG", ...)` with the right label.
 */

/**
 * Strip dangerous characters from a filename-ish string so it is
 * safe to interpolate into HTML/Telegram/shell/log contexts.
 */
function safeName(s) {
    return s?.replace(/[<>\[\]\r\n;]/g, "_")
}

/**
 * Convert a Grammy context into a chat_user_message or
 * telegram_callback_query event (or [] for anything we don't translate).
 *
 * The emitted event type is `chat_user_message` — the platform-agnostic
 * name the event-loop uses for "a user sent a chat message." Other
 * platform translators (e.g. a future discord-translator.js) emit the
 * same event type, so the downstream handler only has to know one
 * event name regardless of origin. The `telegram_callback_query`
 * event is Telegram-specific (inline-keyboard button presses) and
 * keeps its platform-prefixed name.
 *
 * @param {object} ctx — grammy Context
 * @returns {object[]} events to enqueue
 */
export function translateTelegramMessage(ctx) {
    const msg = ctx?.message
    if (msg) {
        const chat = ctx.chat
        const from = ctx.from
        const base = {
            type: "chat_user_message",
            ts: Date.now(),
            chatId: String(chat.id),
            userId: String(from?.id ?? ""),
            username: from?.username ?? null,
            messageId: msg.message_id,
            replyToMessageId: msg.reply_to_message?.message_id ?? null,
            replyToText: msg.reply_to_message?.text ?? null,
            chatType: chat.type,
            // _ctx carries the Grammy context for handlers that need
            // direct access (e.g. hot-command bridge). Underscore
            // prefix → non-serializable, preserved by-reference
            // through mergeSessionData.
            _ctx: ctx,
        }

        // ── Plain text ────────────────────────────────────────────
        if (msg.text) {
            return [{
                ...base,
                text: msg.text,
                attachment: null,
            }]
        }

        // ── Photo ─────────────────────────────────────────────────
        if (msg.photo && msg.photo.length > 0) {
            const best = msg.photo[msg.photo.length - 1]
            return [{
                ...base,
                text: msg.caption ?? "(photo)",
                attachment: {
                    kind: "photo",
                    fileId: best.file_id,
                    fileUniqueId: best.file_unique_id,
                },
            }]
        }

        // ── Document ──────────────────────────────────────────────
        if (msg.document) {
            const doc = msg.document
            const name = safeName(doc.file_name)
            return [{
                ...base,
                text: msg.caption ?? `(document: ${name ?? "file"})`,
                attachment: {
                    kind: "document",
                    fileId: doc.file_id,
                    size: doc.file_size,
                    mime: doc.mime_type,
                    name,
                },
            }]
        }

        // ── Voice ─────────────────────────────────────────────────
        if (msg.voice) {
            const voice = msg.voice
            return [{
                ...base,
                text: msg.caption ?? "(voice message)",
                attachment: {
                    kind: "voice",
                    fileId: voice.file_id,
                    size: voice.file_size,
                    mime: voice.mime_type,
                },
            }]
        }

        // ── Audio ─────────────────────────────────────────────────
        if (msg.audio) {
            const audio = msg.audio
            const name = safeName(audio.file_name)
            const title = safeName(audio.title)
            return [{
                ...base,
                text: msg.caption ?? `(audio: ${title ?? name ?? "audio"})`,
                attachment: {
                    kind: "audio",
                    fileId: audio.file_id,
                    size: audio.file_size,
                    mime: audio.mime_type,
                    name,
                },
            }]
        }

        // ── Video ─────────────────────────────────────────────────
        if (msg.video) {
            const video = msg.video
            return [{
                ...base,
                text: msg.caption ?? "(video)",
                attachment: {
                    kind: "video",
                    fileId: video.file_id,
                    size: video.file_size,
                    mime: video.mime_type,
                    name: safeName(video.file_name),
                },
            }]
        }

        // ── Video note ────────────────────────────────────────────
        if (msg.video_note) {
            const vn = msg.video_note
            return [{
                ...base,
                text: "(video note)",
                attachment: {
                    kind: "video_note",
                    fileId: vn.file_id,
                    size: vn.file_size,
                },
            }]
        }

        // ── Sticker ───────────────────────────────────────────────
        if (msg.sticker) {
            const sticker = msg.sticker
            const emoji = sticker.emoji ? ` ${sticker.emoji}` : ""
            return [{
                ...base,
                text: `(sticker${emoji})`,
                attachment: {
                    kind: "sticker",
                    fileId: sticker.file_id,
                    size: sticker.file_size,
                },
            }]
        }
    }

    if (ctx?.callbackQuery) {
        const cq = ctx.callbackQuery
        const from = ctx.from
        return [{
            type: "telegram_callback_query",
            ts: Date.now(),
            chatId: String(ctx.chat?.id ?? ""),
            userId: String(from?.id ?? ""),
            queryId: cq.id,
            data: cq.data,
            _ctx: ctx,
        }]
    }

    return []
}
