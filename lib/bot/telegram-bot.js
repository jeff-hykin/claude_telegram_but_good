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

        // ── Rate-limit queue ────────────────────────────────────────
        this._queue = []            // { priority, fn, resolve, reject, label }
        this._draining = false
        this._rateLimitedUntil = 0  // epoch ms
        this._stats = { sent: 0, retried: 0, dropped: 0 }

        // ── Sliding-window rate tracker ─────────────────────────────
        // Tracks timestamps of all completed API calls in a 60s window.
        // Used to compute current actions/minute and detect high pressure.
        this._sendTimestamps = []    // epoch ms of each completed call
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
        this._grammy.on("message:forum_topic_created", dispatch)
        this._grammy.on("message:forum_topic_edited", dispatch)

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

    // ── Rate-limit queue ────────────────────────────────────────────

    /**
     * Max low-priority items allowed in the queue. Beyond this, new
     * low-priority requests are dropped immediately.
     */
    static LOW_QUEUE_CAP = 30

    /**
     * Telegram's per-group rate limit (approximate). The actual limit
     * varies (20/min for groups, 30/sec burst globally), but this is
     * the conservative ceiling for sustained traffic to a single group.
     */
    static RATE_LIMIT_PER_MINUTE = 20

    /**
     * When actions/minute exceeds this fraction of RATE_LIMIT_PER_MINUTE,
     * low-priority items are proactively dropped to preserve headroom
     * for important messages. Set to null to disable proactive dropping.
     */
    static HIGH_PRESSURE_THRESHOLD = 0.85

    /**
     * Sliding window length in ms for tracking actions/minute.
     */
    static WINDOW_MS = 60_000

    /**
     * Record a completed API call timestamp and prune entries older
     * than the sliding window.
     */
    _recordSend() {
        const now = Date.now()
        this._sendTimestamps.push(now)
        const cutoff = now - TelegramBot.WINDOW_MS
        while (this._sendTimestamps.length > 0 && this._sendTimestamps[0] < cutoff) {
            this._sendTimestamps.shift()
        }
    }

    /**
     * Current actions per minute (based on the sliding window).
     */
    get actionsPerMinute() {
        const cutoff = Date.now() - TelegramBot.WINDOW_MS
        while (this._sendTimestamps.length > 0 && this._sendTimestamps[0] < cutoff) {
            this._sendTimestamps.shift()
        }
        return this._sendTimestamps.length
    }

    /**
     * Whether we're in the high-pressure zone (proactively drop low-priority).
     */
    get _isHighPressure() {
        const threshold = TelegramBot.HIGH_PRESSURE_THRESHOLD
        if (threshold == null) { return false }
        return this.actionsPerMinute >= Math.floor(TelegramBot.RATE_LIMIT_PER_MINUTE * threshold)
    }

    /**
     * Enqueue an outbound API call. Returns a promise that resolves
     * with the call's return value (or `{ dropped: true }` if the
     * item was dropped due to rate limiting or high pressure).
     *
     * @param {"high"|"low"} priority
     * @param {string} label — for logging (e.g. "sendText", "editText")
     * @param {() => Promise<any>} fn — the Grammy call to execute
     */
    _enqueue(priority, label, fn) {
        if (priority === "low") {
            // Drop if queue is already backed up
            const lowCount = this._queue.filter(e => e.priority === "low").length
            if (lowCount >= TelegramBot.LOW_QUEUE_CAP) {
                this._stats.dropped++
                this._log(`DROP ${label} — low-priority queue full (${lowCount})`)
                return Promise.resolve({ dropped: true })
            }
            // Proactive drop under high pressure
            if (this._isHighPressure) {
                this._stats.dropped++
                this._log(`DROP ${label} — high pressure (${this.actionsPerMinute}/${TelegramBot.RATE_LIMIT_PER_MINUTE} actions/min)`)
                return Promise.resolve({ dropped: true })
            }
        }

        return new Promise((resolve, reject) => {
            this._queue.push({ priority, label, fn, resolve, reject })
            this._drain()
        })
    }

    /**
     * Process queued items one at a time. On 429, waits retry_after
     * for high-priority items and drops low-priority items.
     */
    async _drain() {
        if (this._draining) { return }
        this._draining = true

        try {
            while (this._queue.length > 0) {
                // If we're currently rate-limited, wait it out
                const now = Date.now()
                if (this._rateLimitedUntil > now) {
                    // Purge low-priority items while waiting — resolve their
                    // promises so callers don't hang forever.
                    const kept = []
                    let purged = 0
                    for (const e of this._queue) {
                        if (e.priority === "high") {
                            kept.push(e)
                        } else {
                            e.resolve({ dropped: true })
                            purged++
                        }
                    }
                    this._queue = kept
                    if (purged > 0) {
                        this._stats.dropped += purged
                        this._log(`PURGE ${purged} low-priority items during rate limit`)
                    }
                    if (this._queue.length === 0) { break }

                    const waitMs = this._rateLimitedUntil - now
                    this._log(`WAIT ${(waitMs / 1000).toFixed(1)}s for rate limit`)
                    await new Promise(r => setTimeout(r, waitMs))
                }

                const entry = this._queue.shift()
                if (!entry) { break }

                // Proactive drop: if pressure is high and this is low-priority,
                // skip it now to preserve headroom for important calls.
                if (entry.priority === "low" && this._isHighPressure) {
                    this._stats.dropped++
                    this._log(`DROP ${entry.label} — high pressure at drain time (${this.actionsPerMinute}/${TelegramBot.RATE_LIMIT_PER_MINUTE} actions/min)`)
                    entry.resolve({ dropped: true })
                    continue
                }

                try {
                    const result = await entry.fn()
                    this._stats.sent++
                    this._recordSend()
                    entry.resolve(result)
                } catch (e) {
                    const retryAfter = this._parseRetryAfter(e)
                    if (retryAfter != null) {
                        this._rateLimitedUntil = Date.now() + retryAfter * 1000
                        this._recordSend() // 429 still counts as an API call
                        this._log(`429 retry_after=${retryAfter}s on ${entry.label} (${this.actionsPerMinute} actions/min)`)

                        if (entry.priority === "high") {
                            // Re-queue at front for retry
                            this._queue.unshift(entry)
                            this._stats.retried++
                        } else {
                            // Drop low-priority on rate limit
                            this._stats.dropped++
                            this._log(`DROP ${entry.label} (low-priority, rate limited)`)
                            entry.resolve({ dropped: true })
                        }
                    } else {
                        // Non-rate-limit error — let caller handle it
                        entry.reject(e)
                    }
                }
            }
        } finally {
            this._draining = false
        }
    }

    /**
     * Extract retry_after seconds from a Grammy 429 error, or null
     * if this isn't a rate-limit error.
     */
    _parseRetryAfter(e) {
        if (e?.error_code === 429 || e?.statusCode === 429) {
            return e?.parameters?.retry_after ?? e?.retry_after ?? 5
        }
        const desc = String(e?.description ?? e?.message ?? "")
        const m = /retry after (\d+)/i.exec(desc)
        if (m) { return Number(m[1]) }
        return null
    }

    /** Simple log helper (this file uses static imports, no dbg). */
    _log(msg) {
        const ts = new Date().toISOString()
        console.error(`[TG-RATE ${ts}] ${msg}`)
    }

    /** Current queue stats and rate tracking for debugging. */
    get rateLimitStats() {
        return {
            ...this._stats,
            actionsPerMinute: this.actionsPerMinute,
            rateLimit: TelegramBot.RATE_LIMIT_PER_MINUTE,
            pressure: TelegramBot.RATE_LIMIT_PER_MINUTE > 0
                ? +(this.actionsPerMinute / TelegramBot.RATE_LIMIT_PER_MINUTE).toFixed(2)
                : 0,
            highPressureThreshold: TelegramBot.HIGH_PRESSURE_THRESHOLD,
            isHighPressure: this._isHighPressure,
            queueLength: this._queue.length,
            rateLimitedUntil: this._rateLimitedUntil > Date.now()
                ? new Date(this._rateLimitedUntil).toISOString()
                : null,
        }
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
        if (opts.threadId != null) {
            opts.message_thread_id = Number(opts.threadId)
            delete opts.threadId
        }
        if (opts.silent) {
            opts.disable_notification = true
            delete opts.silent
        }
        return opts
    }

    async sendText(chatId, text, options) {
        this._assertStarted("sendText")
        return this._enqueue("high", "sendText", async () => {
            const sent = await this._grammy.api.sendMessage(
                chatId,
                text,
                this._toGrammyOptions(options),
            )
            return { messageId: String(sent?.message_id ?? "") }
        })
    }

    async sendFile(chatId, filePath, options = {}) {
        this._assertStarted("sendFile")
        // Read bytes before queueing so the file is captured at call time,
        // not at drain time (it might change or be deleted in between).
        const { filename, caption, format, threadId } = options
        const opts = {}
        if (caption) {
            opts.caption = caption
            if (format === "html") { opts.parse_mode = "HTML" }
            else if (format === "markdown") { opts.parse_mode = "MarkdownV2" }
        }
        if (threadId != null) {
            opts.message_thread_id = Number(threadId)
        }
        const PHOTO_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"])
        const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase()
        const isPhoto = PHOTO_EXTS.has(ext)
        const bytes = Deno.readFileSync(filePath)
        const input = new InputFile(bytes, filename ?? filePath.split("/").pop())

        return this._enqueue("high", "sendFile", async () => {
            const sent = isPhoto
                ? await this._grammy.api.sendPhoto(chatId, input, opts)
                : await this._grammy.api.sendDocument(chatId, input, opts)
            return { messageId: String(sent?.message_id ?? "") }
        })
    }

    async editText(chatId, messageId, text, options) {
        this._assertStarted("editText")
        return this._enqueue("low", "editText", async () => {
            await this._grammy.api.editMessageText(
                chatId,
                Number(messageId),
                text,
                this._toGrammyOptions(options),
            )
        })
    }

    async deleteMessage(chatId, messageId) {
        this._assertStarted("deleteMessage")
        return this._enqueue("low", "deleteMessage", async () => {
            try {
                await this._grammy.api.deleteMessage(chatId, Number(messageId))
                return true
            } catch (_e) {
                return false
            }
        })
    }

    // ── Threads / Forum Topics ──────────────────────────────────────

    async createThread(chatId, title, _options) {
        this._assertStarted("createThread")
        return this._enqueue("high", "createThread", async () => {
            const result = await this._grammy.api.createForumTopic(chatId, title)
            return { threadId: String(result.message_thread_id) }
        })
    }

    async closeThread(chatId, threadId) {
        this._assertStarted("closeThread")
        return this._enqueue("high", "closeThread", async () => {
            try {
                await this._grammy.api.closeForumTopic(chatId, Number(threadId))
                return true
            } catch (_e) {
                return false
            }
        })
    }

    async deleteThread(chatId, threadId) {
        this._assertStarted("deleteThread")
        return this._enqueue("high", "deleteThread", async () => {
            try {
                await this._grammy.api.deleteForumTopic(chatId, Number(threadId))
                return true
            } catch (_e) {
                return false
            }
        })
    }

    async reopenThread(chatId, threadId) {
        this._assertStarted("reopenThread")
        return this._enqueue("high", "reopenThread", async () => {
            try {
                await this._grammy.api.reopenForumTopic(chatId, Number(threadId))
                return true
            } catch (_e) {
                return false
            }
        })
    }

    async renameThread(chatId, threadId, title) {
        this._assertStarted("renameThread")
        return this._enqueue("high", "renameThread", async () => {
            try {
                await this._grammy.api.editForumTopic(chatId, Number(threadId), { name: title })
                return true
            } catch (_e) {
                return false
            }
        })
    }

    async react(chatId, messageId, emoji) {
        this._assertStarted("react")
        return this._enqueue("low", "react", async () => {
            const reactions = emoji ? [{ type: "emoji", emoji }] : []
            await this._grammy.api.setMessageReaction(chatId, Number(messageId), reactions)
            return true
        })
    }

    async answerCallback(queryId, text) {
        this._assertStarted("answerCallback")
        return this._enqueue("low", "answerCallback", async () => {
            await this._grammy.api.answerCallbackQuery(queryId, text ? { text } : undefined)
            return true
        })
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
     * Publish the slash-command menu. Telegram's API requires each
     * entry's `command` to be lowercase `a-z0-9_` up to 32 chars and
     * `description` to be 1–256 chars; we filter noncompliant
     * entries rather than rejecting the whole call so a single
     * malformed name doesn't drop the menu.
     *
     * Telegram resolves commands via a scope hierarchy: more-specific
     * scopes (BotCommandScopeAllPrivateChats, AllGroupChats, etc.)
     * override the default. If an older build of the bot ever called
     * setMyCommands with an explicit scope, those entries persist
     * even after we rewrite the default — which is how `/spawn` kept
     * showing up in private chats for weeks after it was removed.
     *
     * Fix: publish to `default`, then explicitly OVERWRITE the
     * private-chat and group scopes with the same list. That way any
     * scope-overrides held over from prior installs get replaced
     * with the current registry, not left to shadow the default.
     */
    async setCommands(commands) {
        this._assertStarted("setCommands")
        if (!Array.isArray(commands)) { return false }
        const NAME_RE = /^[a-z][a-z0-9_]{0,31}$/
        const filtered = []
        for (const entry of commands) {
            if (!entry || typeof entry.command !== "string") { continue }
            const name = entry.command.replace(/^\//, "")
            if (!NAME_RE.test(name)) { continue }
            const desc = typeof entry.description === "string"
                ? entry.description.slice(0, 256)
                : ""
            if (!desc) { continue }
            filtered.push({ command: name, description: desc })
        }
        const api = this._grammy.api
        let ok = true
        try {
            await api.setMyCommands(filtered)
        } catch (_e) {
            ok = false
        }
        // Overwrite more-specific scopes so stale entries published by
        // older builds can't shadow the default list. Per-scope
        // failures are non-fatal — the default publish above is the
        // one that matters for most clients.
        try {
            await api.setMyCommands(filtered, { scope: { type: "all_private_chats" } })
        } catch (_e) { /* non-fatal, default scope already set */ }
        try {
            await api.setMyCommands(filtered, { scope: { type: "all_group_chats" } })
        } catch (_e) { /* non-fatal */ }
        try {
            await api.setMyCommands(filtered, { scope: { type: "all_chat_administrators" } })
        } catch (_e) { /* non-fatal */ }
        return ok
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
            threads: true,
        }
    }

    // ── Private helpers ──────────────────────────────────────────────

    _assertStarted(method) {
        if (!this._grammy || !this._started) {
            throw new Error(`TelegramBot: ${method}() called before start()`)
        }
    }
}
