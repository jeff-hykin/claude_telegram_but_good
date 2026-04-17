// ---------------------------------------------------------------------------
// lib/bot/bot.js — abstract chat-platform `Bot` base class.
//
// CBG's daemon talks to a chat platform (currently Telegram via Grammy) to
// receive user messages and post replies. This file defines the base
// class that every concrete adapter must implement. The goal is that
// `main-server.js`, the effects layer, and every event handler can talk
// to `core.bot` without knowing (or caring) whether the platform is
// Telegram, Discord, Slack, or something else.
//
//
// ── Method contract ────────────────────────────────────────────────────
//
// Concrete subclasses MUST implement:
//   - async start()                 — connect + begin receiving events
//   - async stop()                  — disconnect cleanly
//   - onMessage(handler)            — register an inbound-message callback
//     where `handler(rawCtx)` is fired once per incoming user message.
//     In Phase 1 `rawCtx` is platform-specific (a Grammy Context for
//     TelegramBot); Phase 2 will normalize it to a ChatMessage shape.
//
// SHOULD implement (defaults throw `Error("abstract")`):
//   - async sendText(chatId, text, options?) → { messageId }
//   - async sendFile(chatId, filePath, options?) → { messageId }
//   - async editText(chatId, messageId, text, options?) → void
//   - async react(chatId, messageId, emoji) → boolean (false if unsupported)
//   - async answerCallback(queryId, text?) → boolean (false if unsupported)
//   - async downloadFile(fileRef, localPath) → boolean
//   - async deleteMessage(chatId, messageId) → void
//
// MAY override (sensible defaults):
//   - get supports() — capability flags for features that vary by platform
//     (reactions, inline buttons, HTML/Markdown formatting, etc.). Callers
//     that produce optional features check these flags instead of
//     branching on subclass type.
//
// None of these are called yet in Phase 1 — the existing effects still go
// through the `.api` passthrough. They exist in the base class so Phase 2
// has a stable target to migrate toward.
//
// ── Related files ──────────────────────────────────────────────────────
//
//   lib/bot/telegram-bot.js
//     The one concrete adapter today. The ONLY file in the codebase
//     allowed to import from Grammy (`imports.js`'s Grammy re-exports).
//
//   (future) lib/bot/discord-bot.js
//     Would inherit from this class and implement every method using a
//     Discord client.
// ---------------------------------------------------------------------------

/**
 * Abstract base class for a chat-platform bot adapter.
 *
 * @abstract
 */
export class Bot {
    /**
     * @param {object} _config — adapter-specific connection details (token,
     *   server URL, credentials, ...). Subclasses document their own shape.
     */
    constructor(_config) {
        if (new.target === Bot) {
            throw new Error("Bot is abstract; instantiate a subclass (e.g. TelegramBot)")
        }
    }

    // ── Lifecycle ────────────────────────────────────────────────────

    /** Connect to the platform and begin receiving events. */
    async start() { throw new Error("Bot.start() is abstract") }

    /** Disconnect cleanly. After this returns no callbacks fire. */
    async stop() { throw new Error("Bot.stop() is abstract") }

    // ── Inbound ──────────────────────────────────────────────────────

    /**
     * Register a callback fired once per inbound user message (text,
     * photo, document, voice, audio, video, video_note, sticker, and
     * callback-query button presses).
     *
     * Phase 1: `handler` receives the platform-native context object
     * unchanged (a Grammy Context for TelegramBot). The caller is
     * responsible for translating it via lib/pure/telegram-translator.js.
     *
     * Phase 2 will normalize the argument to a ChatMessage record so
     * callers don't need platform-specific parsing.
     *
     * @param {(rawCtx: unknown) => void|Promise<void>} _handler
     */
    onMessage(_handler) { throw new Error("Bot.onMessage() is abstract") }

    // ── Outbound (Phase 2 targets — not called yet) ──────────────────

    /**
     * Send a text message to a chat. Returns the platform's message ID
     * of the sent message so callers can later `editText` or `react` it.
     *
     * @param {string} _chatId
     * @param {string} _text
     * @param {SendOptions} [_options]
     * @returns {Promise<{ messageId: string }>}
     */
    async sendText(_chatId, _text, _options) { throw new Error("Bot.sendText() is abstract") }

    /**
     * Send a file (photo / document / audio / video / ...) to a chat.
     * The adapter classifies by extension + MIME and picks the right
     * platform method.
     *
     * @param {string} _chatId
     * @param {string} _filePath
     * @param {SendOptions} [_options]
     * @returns {Promise<{ messageId: string }>}
     */
    async sendFile(_chatId, _filePath, _options) { throw new Error("Bot.sendFile() is abstract") }

    /**
     * Edit a previously-sent message's text in place.
     *
     * @param {string} _chatId
     * @param {string} _messageId
     * @param {string} _text
     * @param {SendOptions} [_options]
     */
    async editText(_chatId, _messageId, _text, _options) { throw new Error("Bot.editText() is abstract") }

    /**
     * Delete a previously-sent message. Not all platforms support this
     * after a time window; adapters are allowed to no-op + return false.
     *
     * @param {string} _chatId
     * @param {string} _messageId
     * @returns {Promise<boolean>}
     */
    async deleteMessage(_chatId, _messageId) { return false }

    // ── Threads / Forum Topics ──────────────────────────────────────

    async createThread(_chatId, _title, _options) { throw new Error("Bot.createThread() is abstract") }
    async closeThread(_chatId, _threadId) { return false }
    async deleteThread(_chatId, _threadId) { return false }
    async reopenThread(_chatId, _threadId) { return false }
    async renameThread(_chatId, _threadId, _title) { return false }

    /**
     * Add an emoji reaction to a message. Platforms that don't support
     * reactions return false instead of throwing.
     *
     * @param {string} _chatId
     * @param {string} _messageId
     * @param {string} _emoji
     * @returns {Promise<boolean>}
     */
    async react(_chatId, _messageId, _emoji) { return false }

    /**
     * Acknowledge a callback-query button press. On platforms without
     * explicit callback-query acks this returns false.
     *
     * @param {string} _queryId
     * @param {string} [_text] — optional toast text shown to the user
     * @returns {Promise<boolean>}
     */
    async answerCallback(_queryId, _text) { return false }

    /**
     * Download a platform-referenced file to a local path.
     *
     * @param {string} _fileRef — Telegram file_id, Discord attachment URL, etc.
     * @param {string} _localPath — destination on disk
     * @returns {Promise<boolean>} — true on success
     */
    async downloadFile(_fileRef, _localPath) { throw new Error("Bot.downloadFile() is abstract") }

    /**
     * Publish the list of slash commands the platform should show in
     * its command menu (Telegram's `setMyCommands`, Discord's
     * application commands list, etc). Idempotent and replacement-
     * style: the argument is the COMPLETE list, anything not in it
     * is removed from the platform's menu.
     *
     * Default: no-op returning false, so platforms that don't have a
     * menu concept don't need to implement anything.
     *
     * @param {{ command: string, description: string }[]} _commands
     *   Each entry's `command` MUST be a slash-command-safe name
     *   (lowercase, `a-z0-9_`, ≤32 chars, no leading `/`) and
     *   `description` MUST be 1–256 chars. Adapters are free to
     *   filter entries that don't meet their platform's constraints
     *   rather than rejecting the whole call.
     * @returns {Promise<boolean>} — true on success, false on
     *   unsupported / failed.
     */
    async setCommands(_commands) { return false }

    // ── Capability flags ─────────────────────────────────────────────

    /**
     * Platform capability flags. Callers that produce optional features
     * (inline button keyboards, message reactions, HTML/Markdown
     * formatting) should check these flags instead of branching on the
     * concrete subclass.
     *
     * @returns {{
     *   reactions: boolean,
     *   inlineButtons: boolean,
     *   htmlFormatting: boolean,
     *   markdownFormatting: boolean,
     *   fileDownload: boolean,
     * }}
     */
    get supports() {
        return {
            reactions: false,
            inlineButtons: false,
            htmlFormatting: false,
            markdownFormatting: false,
            fileDownload: false,
            threads: false,
        }
    }
}

// ── Generic type definitions (JSDoc) ───────────────────────────────────
// These describe the shapes Phase 2+ will normalize to. Nothing uses them
// yet — they're here so the eventual migration has a target to point at.

/**
 * @typedef {Object} ChatMessage
 * @property {string} chatId
 * @property {string} userId
 * @property {string|null} username
 * @property {string} messageId
 * @property {string} text
 * @property {string|null} replyToMessageId
 * @property {string|null} replyToText
 * @property {"private"|"group"|null} chatType
 * @property {ChatAttachment|null} attachment
 * @property {number} ts
 * @property {unknown} _raw
 */

/**
 * @typedef {Object} ChatAttachment
 * @property {"image"|"document"|"audio"|"video"|"sticker"|"other"} kind
 * @property {string} fileRef
 * @property {string|null} name
 * @property {string|null} mime
 * @property {number|null} size
 */

/**
 * @typedef {Object} CallbackQuery
 * @property {string} chatId
 * @property {string} userId
 * @property {string} queryId
 * @property {string} data
 */

/**
 * @typedef {Object} SendOptions
 * @property {"plain"|"html"|"markdown"} [format]
 * @property {Button[][]} [buttons]
 * @property {string} [replyToMessageId]
 * @property {string|number} [threadId]
 */

/**
 * @typedef {Object} Button
 * @property {string} label
 * @property {string} callbackData
 */
