// ---------------------------------------------------------------------------
// lib/bot/telegram-bot.js — Grammy-backed Telegram adapter.
//
// The ONE place in the codebase allowed to import from Grammy. Everything
// else — main-server.js, the effects layer, event handlers — goes through
// the abstract `Bot` base class in lib/bot/bot.js.
//
// Phase 2 status: all outbound operations are first-class methods on this
// class. The previous `.api` passthrough getter is gone; nothing outside
// this file can reach Grammy directly.
// ---------------------------------------------------------------------------

import { Bot as GrammyBot, InputFile, InlineKeyboard } from "../../imports.js"
import { Bot } from "./bot.js"

/**
 * Telegram adapter backed by Grammy's long-poll client.
 */
export class TelegramBot extends Bot {
    /**
     * @param {{ token: string }} config
     */
    constructor(config) {
        super(config)
        if (!config?.token) {
            throw new Error("TelegramBot: config.token is required")
        }
        this._token = config.token
        this._grammy = null
        this._onMessage = null
        this._started = false
    }

    // ── Lifecycle ────────────────────────────────────────────────────

    async start() {
        if (this._started) {
            throw new Error("TelegramBot: already started")
        }
        this._grammy = new GrammyBot(this._token)

        const dispatch = (ctx) => {
            if (this._onMessage) {
                try { return this._onMessage(ctx) } catch (_e) { /* handler logs */ }
            }
        }
        this._grammy.on("message:text", dispatch)
        this._grammy.on("message:photo", dispatch)
        this._grammy.on("message:document", dispatch)
        this._grammy.on("message:voice", dispatch)
        this._grammy.on("message:audio", dispatch)
        this._grammy.on("message:video", dispatch)
        this._grammy.on("message:video_note", dispatch)
        this._grammy.on("message:sticker", dispatch)
        this._grammy.on("callback_query:data", dispatch)

        return await new Promise((resolve, reject) => {
            let settled = false
            ;(async () => {
                try {
                    await this._grammy.start({
                        onStart: () => {
                            if (!settled) {
                                settled = true
                                this._started = true
                                resolve()
                            }
                        },
                    })
                } catch (e) {
                    if (!settled) {
                        settled = true
                        reject(e)
                    }
                }
            })()
        })
    }

    async stop() {
        if (this._grammy && this._started) {
            try {
                await this._grammy.stop()
            } finally {
                this._started = false
            }
        }
    }

    // ── Inbound ──────────────────────────────────────────────────────

    onMessage(handler) {
        this._onMessage = handler
    }

    // ── Outbound ─────────────────────────────────────────────────────

    /**
     * Convert abstract SendOptions into Grammy's options shape.
     *
     *   format: "html"     → parse_mode: "HTML"
     *   format: "markdown" → parse_mode: "MarkdownV2"
     *   format: "plain"    → no parse_mode
     *   buttons: Button[][] → reply_markup: InlineKeyboard
     *   replyToMessageId   → reply_parameters: { message_id }
     *
     * Any unrecognized field on the abstract options is passed through
     * so Grammy-specific callers inside this file can still set things
     * like `reply_markup` directly if they already have a Grammy object.
     */
    _toGrammyOptions(options) {
        const opts = { ...(options ?? {}) }
        if (opts.format === "html") { opts.parse_mode = "HTML" }
        else if (opts.format === "markdown") { opts.parse_mode = "MarkdownV2" }
        delete opts.format
        if (Array.isArray(opts.buttons) && opts.buttons.length > 0) {
            const kb = new InlineKeyboard()
            for (let row = 0; row < opts.buttons.length; row++) {
                for (const btn of opts.buttons[row]) {
                    kb.text(btn.label, btn.callbackData)
                }
                if (row < opts.buttons.length - 1) { kb.row() }
            }
            opts.reply_markup = kb
            delete opts.buttons
        }
        if (opts.replyToMessageId != null) {
            opts.reply_parameters = { message_id: Number(opts.replyToMessageId) }
            delete opts.replyToMessageId
        }
        return opts
    }

    async sendText(chatId, text, options) {
        this._assertStarted("sendText")
        const sent = await this._grammy.api.sendMessage(
            chatId,
            text,
            this._toGrammyOptions(options),
        )
        return { messageId: String(sent?.message_id ?? "") }
    }

    async sendFile(chatId, filePath, options = {}) {
        this._assertStarted("sendFile")
        const { filename, caption, format } = options
        const opts = {}
        if (caption) {
            opts.caption = caption
            if (format === "html") { opts.parse_mode = "HTML" }
            else if (format === "markdown") { opts.parse_mode = "MarkdownV2" }
        }
        // Photos get sendPhoto for inline rendering; everything else is a
        // document. The extension-based split lives here because it's
        // Telegram-specific — Discord, for example, doesn't distinguish.
        const PHOTO_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"])
        const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase()
        const isPhoto = PHOTO_EXTS.has(ext)
        const input = new InputFile(filePath, filename)
        const sent = isPhoto
            ? await this._grammy.api.sendPhoto(chatId, input, opts)
            : await this._grammy.api.sendDocument(chatId, input, opts)
        return { messageId: String(sent?.message_id ?? "") }
    }

    async editText(chatId, messageId, text, options) {
        this._assertStarted("editText")
        await this._grammy.api.editMessageText(
            chatId,
            Number(messageId),
            text,
            this._toGrammyOptions(options),
        )
    }

    async deleteMessage(chatId, messageId) {
        this._assertStarted("deleteMessage")
        try {
            await this._grammy.api.deleteMessage(chatId, Number(messageId))
            return true
        } catch (_e) {
            return false
        }
    }

    async react(chatId, messageId, emoji) {
        this._assertStarted("react")
        const reactions = emoji ? [{ type: "emoji", emoji }] : []
        await this._grammy.api.setMessageReaction(chatId, Number(messageId), reactions)
        return true
    }

    async answerCallback(queryId, text) {
        this._assertStarted("answerCallback")
        await this._grammy.api.answerCallbackQuery(queryId, text ? { text } : undefined)
        return true
    }

    /**
     * Download a Telegram file_id to a local path. The caller passes the
     * file_id as `fileRef`; this method handles the two-step Telegram
     * dance (getFile → fetch file URL → write to disk). Returns true
     * on success, false on any failure.
     */
    async downloadFile(fileRef, localPath) {
        this._assertStarted("downloadFile")
        let file
        try {
            file = await this._grammy.api.getFile(fileRef)
        } catch (_e) {
            return false
        }
        if (!file?.file_path) { return false }
        const url = `https://api.telegram.org/file/bot${this._token}/${file.file_path}`
        let res
        try {
            res = await fetch(url)
        } catch (_e) {
            return false
        }
        if (!res.ok) { return false }
        const buf = new Uint8Array(await res.arrayBuffer())
        try {
            Deno.writeFileSync(localPath, buf)
        } catch (_e) {
            return false
        }
        return true
    }

    /**
     * Platform-specific extension used only by telegram-download.js to
     * discover the server-side file extension before constructing the
     * local path. Returns the file_path string Telegram gives us (or
     * null if getFile failed).
     */
    async getFileExtension(fileRef) {
        this._assertStarted("getFileExtension")
        try {
            const file = await this._grammy.api.getFile(fileRef)
            if (!file?.file_path) { return null }
            const ext = file.file_path.split(".").pop()
            return ext || null
        } catch (_e) {
            return null
        }
    }

    // ── Capability flags ─────────────────────────────────────────────

    get supports() {
        return {
            reactions: true,
            inlineButtons: true,
            htmlFormatting: true,
            markdownFormatting: false, // house rule: we don't use Markdown
            fileDownload: true,
        }
    }

    // ── Private helpers ──────────────────────────────────────────────

    _assertStarted(method) {
        if (!this._grammy || !this._started) {
            throw new Error(`TelegramBot: ${method}() called before start()`)
        }
    }
}
