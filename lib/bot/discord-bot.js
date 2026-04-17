// ---------------------------------------------------------------------------
// lib/bot/discord-bot.js — Discord adapter.
//
// A minimal, hand-rolled Discord adapter built directly against Discord's
// REST + Gateway APIs — no third-party library. The goal is to validate
// that the `Bot` abstraction in bot.js is actually cross-platform: the
// event loop, effects layer, and every event handler work unchanged
// when `core.bot` is this class instead of TelegramBot.
//
// This is DELIBERATELY not a production-grade Discord client. Scope:
//
//   WORKS (enough to demo the abstraction):
//     - Gateway connect + HELLO/HEARTBEAT/IDENTIFY lifecycle
//     - MESSAGE_CREATE → onMessage handler with a Grammy-shaped ctx
//       that `lib/pure/telegram-translator.js` can consume (see the
//       #ctxFromMessage adapter below)
//     - sendText via POST /channels/{id}/messages
//     - editText via PATCH /channels/{id}/messages/{id}
//     - deleteMessage via DELETE /channels/{id}/messages/{id}
//     - react via PUT /channels/{cid}/messages/{mid}/reactions/{emoji}/@me
//     - downloadFile (Discord attachments are plain URLs — just fetch)
//
//   NOT IMPLEMENTED (intentional, flagged in capability matrix):
//     - sendFile (multipart form upload — skip until there's a concrete
//       Discord use case; current callers check `supports.fileDownload`
//       on the read side, not sending)
//     - Sharding (single-process, single-gateway only)
//     - Slash commands / interactions / buttons (no `answerCallback`,
//       no inline buttons — Discord's interaction model differs enough
//       from Telegram's callback_query that it deserves its own design
//       pass, and CBG's only button today is the one error-recovery
//       prompt inside chat-user.js which is not yet wired to Discord)
//     - RESUME / gateway reconnect after drop — we do a fresh IDENTIFY
//       each time, losing session history. Fine for ad-hoc use.
//     - Rate limiting — we trust Discord's headers but don't enforce
//       them pre-send. Exceeding the rate limit will return 429 and
//       the send logs via dbg(); no local backoff queue.
//     - Privileged MESSAGE_CONTENT intent: the bot must have this
//       enabled in the Developer Portal or messages from channels
//       (other than DMs + mentions) will arrive with empty content.
//
// The goal is "good enough to receive a message and reply to it",
// which is all the Bot abstraction needs to be validated against.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"
import { Bot } from "./bot.js"

const { dbg } = await versionedImport("../logging.js", import.meta)

const DISCORD_API = "https://discord.com/api/v10"
const DISCORD_GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json"

// Intent flags we need to receive user messages in both guild channels
// and DMs. MESSAGE_CONTENT is a privileged intent — see file header.
const INTENT_GUILDS = 1 << 0
const INTENT_GUILD_MESSAGES = 1 << 9
const INTENT_GUILD_MESSAGE_REACTIONS = 1 << 10
const INTENT_DIRECT_MESSAGES = 1 << 12
const INTENT_DIRECT_MESSAGE_REACTIONS = 1 << 13
const INTENT_MESSAGE_CONTENT = 1 << 15
const INTENTS =
    INTENT_GUILDS |
    INTENT_GUILD_MESSAGES |
    INTENT_GUILD_MESSAGE_REACTIONS |
    INTENT_DIRECT_MESSAGES |
    INTENT_DIRECT_MESSAGE_REACTIONS |
    INTENT_MESSAGE_CONTENT

// Gateway opcodes we care about (see Discord docs).
const OP_DISPATCH = 0
const OP_HEARTBEAT = 1
const OP_IDENTIFY = 2
const OP_RESUME = 6
const OP_RECONNECT = 7
const OP_INVALID_SESSION = 9
const OP_HELLO = 10
const OP_HEARTBEAT_ACK = 11

/**
 * Strip Telegram-flavoured HTML tags for Discord's plain-text / Markdown
 * world. Discord doesn't render <b>/<i>/<code>/<pre>, so we collapse:
 *   <b>x</b>   → **x**
 *   <i>x</i>   → *x*
 *   <code>x</code> → `x`
 *   <pre>x</pre>   → ```\nx\n```
 * and strip everything else. This is lossy but preserves readability.
 */
function htmlToDiscordMarkdown(html) {
    return String(html)
        .replace(/<b>(.*?)<\/b>/gs, "**$1**")
        .replace(/<strong>(.*?)<\/strong>/gs, "**$1**")
        .replace(/<i>(.*?)<\/i>/gs, "*$1*")
        .replace(/<em>(.*?)<\/em>/gs, "*$1*")
        .replace(/<pre>([\s\S]*?)<\/pre>/g, "```\n$1\n```")
        .replace(/<code>(.*?)<\/code>/gs, "`$1`")
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
}

/**
 * Discord adapter. Connects via Gateway, sends via REST.
 */
export class DiscordBot extends Bot {
    /**
     * @param {{ token: string }} config
     */
    constructor(config) {
        super(config)
        if (!config?.token) {
            throw new Error("DiscordBot: config.token is required")
        }
        this._token = config.token
        this._ws = null
        this._onMessage = null
        this._started = false
        this._heartbeatInterval = null
        this._lastSeq = null
        this._stopping = false
    }

    // ── Lifecycle ────────────────────────────────────────────────────

    async start() {
        if (this._started) {
            throw new Error("DiscordBot: already started")
        }
        return await new Promise((resolve, reject) => {
            this._ws = new WebSocket(DISCORD_GATEWAY)
            let readyOnce = false
            this._ws.addEventListener("message", (evt) => {
                let payload
                try {
                    payload = JSON.parse(evt.data)
                } catch (e) {
                    dbg("DISCORD", "non-JSON gateway frame:", e)
                    return
                }
                if (payload.s != null) { this._lastSeq = payload.s }

                if (payload.op === OP_HELLO) {
                    this._startHeartbeat(payload.d.heartbeat_interval)
                    this._sendIdentify()
                } else if (payload.op === OP_HEARTBEAT) {
                    this._sendHeartbeat()
                } else if (payload.op === OP_HEARTBEAT_ACK) {
                    // noop
                } else if (payload.op === OP_RECONNECT || payload.op === OP_INVALID_SESSION) {
                    dbg("DISCORD", `gateway requested reconnect (op=${payload.op})`)
                    // Minimal impl: just close; caller must re-start. A
                    // proper client would re-connect with RESUME here.
                    try {
                        this._ws.close()
                    } catch (e) {
                        dbg("DISCORD", "ws close during reconnect:", e)
                    }
                } else if (payload.op === OP_DISPATCH) {
                    if (payload.t === "READY") {
                        dbg("DISCORD", `connected as ${payload.d?.user?.username ?? "(unknown)"}`)
                        if (!readyOnce) {
                            readyOnce = true
                            this._started = true
                            resolve()
                        }
                    } else if (payload.t === "MESSAGE_CREATE") {
                        this._handleMessageCreate(payload.d)
                    }
                }
            })
            this._ws.addEventListener("error", (err) => {
                dbg("DISCORD", "gateway error:", err)
                if (!readyOnce) {
                    readyOnce = true
                    reject(new Error("Discord gateway error before READY"))
                }
            })
            this._ws.addEventListener("close", (evt) => {
                dbg("DISCORD", `gateway closed (code=${evt.code}, reason=${evt.reason})`)
                this._stopHeartbeat()
                if (!readyOnce) {
                    readyOnce = true
                    reject(new Error(`Discord gateway closed before READY: ${evt.code}`))
                }
                this._started = false
            })
        })
    }

    async stop() {
        this._stopping = true
        this._stopHeartbeat()
        if (this._ws) {
            try { this._ws.close(1000, "client stop") } catch (e) { dbg("DISCORD", "ws close:", e) }
            this._ws = null
        }
        this._started = false
    }

    _startHeartbeat(intervalMs) {
        this._stopHeartbeat()
        this._heartbeatInterval = setInterval(() => this._sendHeartbeat(), intervalMs)
    }

    _stopHeartbeat() {
        if (this._heartbeatInterval) {
            clearInterval(this._heartbeatInterval)
            this._heartbeatInterval = null
        }
    }

    _sendHeartbeat() {
        if (this._ws && this._ws.readyState === WebSocket.OPEN) {
            this._ws.send(JSON.stringify({ op: OP_HEARTBEAT, d: this._lastSeq }))
        }
    }

    _sendIdentify() {
        // Match _sendHeartbeat: refuse to send if the socket isn't
        // actually open (could happen if the gateway closes between
        // HELLO arriving and our IDENTIFY going out). Without this
        // guard, a call on a CLOSING/CLOSED socket throws out of the
        // WebSocket message listener with no recovery path.
        if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
            dbg("DISCORD", "skipping IDENTIFY — socket not OPEN")
            return
        }
        this._ws.send(JSON.stringify({
            op: OP_IDENTIFY,
            d: {
                token: this._token,
                intents: INTENTS,
                properties: {
                    os: "linux",
                    browser: "cbg",
                    device: "cbg",
                },
            },
        }))
    }

    _handleMessageCreate(msg) {
        if (!this._onMessage) { return }
        // Ignore our own bot's messages and other bots to avoid loops.
        if (msg.author?.bot) { return }
        // Translate the Discord message into a Grammy-shaped ctx so
        // lib/pure/telegram-translator.js can consume it unchanged.
        // (Phase 3 will drop this when translators move to a generic
        // ChatMessage shape and there's a proper DiscordTranslator.)
        const ctx = this._ctxFromMessage(msg)
        try {
            this._onMessage(ctx)
        } catch (e) {
            dbg("DISCORD", "onMessage handler threw:", e)
        }
    }

    /**
     * Build a Grammy-ctx-shaped object from a Discord MESSAGE_CREATE
     * payload so the existing telegram-translator can consume it.
     * This is a Phase-2 shim. Phase 3 replaces it with a
     * platform-agnostic ChatMessage shape.
     */
    _ctxFromMessage(msg) {
        return {
            chat: {
                id: msg.channel_id,
                type: msg.guild_id ? "group" : "private",
            },
            from: {
                id: msg.author?.id ?? "unknown",
                username: msg.author?.username ?? null,
            },
            message: {
                message_id: msg.id,
                text: msg.content ?? "",
                reply_to_message: msg.referenced_message
                    ? {
                        message_id: msg.referenced_message.id,
                        text: msg.referenced_message.content ?? null,
                    }
                    : undefined,
            },
        }
    }

    // ── Inbound ──────────────────────────────────────────────────────

    onMessage(handler) {
        this._onMessage = handler
    }

    // ── REST helper ──────────────────────────────────────────────────

    async _rest(method, path, body) {
        const url = `${DISCORD_API}${path}`
        const init = {
            method,
            headers: {
                "Authorization": `Bot ${this._token}`,
                "User-Agent": "DiscordBot (cbg, 0.0.0)",
            },
        }
        if (body !== undefined) {
            init.headers["Content-Type"] = "application/json"
            init.body = JSON.stringify(body)
        }
        const res = await fetch(url, init)
        if (!res.ok) {
            const text = await res.text().catch(() => "")
            throw new Error(`Discord ${method} ${path} → ${res.status}: ${text}`)
        }
        if (res.status === 204) { return null }
        return await res.json()
    }

    // ── Outbound ─────────────────────────────────────────────────────

    /**
     * Convert abstract SendOptions into a Discord message payload.
     * Discord uses Markdown natively; HTML is lossy-converted.
     */
    _toDiscordPayload(text, options = {}) {
        let content = String(text ?? "")
        if (options.format === "html") {
            content = htmlToDiscordMarkdown(content)
        }
        // Discord caps content at 2000 chars per message; the effects
        // layer already chunks at 4096 for Telegram. If we receive a
        // chunk larger than 2000, split here too.
        const DISCORD_MAX = 2000
        const payload = {}
        if (content.length > DISCORD_MAX) {
            // The caller will see only the first slice's messageId —
            // multi-part is a pre-existing limitation of single-method
            // returns. For now, truncate + warn.
            dbg("DISCORD", `message ${content.length} chars > 2000, truncating`)
            payload.content = content.slice(0, DISCORD_MAX - 3) + "..."
        } else {
            payload.content = content
        }
        if (options.replyToMessageId) {
            payload.message_reference = { message_id: options.replyToMessageId }
        }
        return payload
    }

    async sendText(chatId, text, options) {
        this._assertStarted("sendText")
        const payload = this._toDiscordPayload(text, options)
        const res = await this._rest("POST", `/channels/${chatId}/messages`, payload)
        return { messageId: String(res?.id ?? "") }
    }

    async sendFile(_chatId, _filePath, _options) {
        throw new Error("DiscordBot: sendFile not implemented (multipart upload TODO)")
    }

    async editText(chatId, messageId, text, options) {
        this._assertStarted("editText")
        const payload = this._toDiscordPayload(text, options)
        await this._rest("PATCH", `/channels/${chatId}/messages/${messageId}`, payload)
    }

    async deleteMessage(chatId, messageId) {
        this._assertStarted("deleteMessage")
        try {
            await this._rest("DELETE", `/channels/${chatId}/messages/${messageId}`)
            return true
        } catch (_e) {
            return false
        }
    }

    // ── Threads / Forum Topics (stubs) ──────────────────────────────

    async createThread(_chatId, _title, _options) {
        throw new Error("DiscordBot: createThread not implemented")
    }

    async react(chatId, messageId, emoji) {
        this._assertStarted("react")
        const encoded = encodeURIComponent(emoji)
        try {
            await this._rest("PUT", `/channels/${chatId}/messages/${messageId}/reactions/${encoded}/@me`)
            return true
        } catch (_e) {
            return false
        }
    }

    async answerCallback(_queryId, _text) {
        // Discord has interactions, not callback queries. Not wired
        // into CBG yet — see file header for scope.
        return false
    }

    /**
     * Discord attachments arrive as `fileRef = URL`. Just fetch it.
     */
    async downloadFile(fileRef, localPath) {
        try {
            const res = await fetch(fileRef)
            if (!res.ok) { return false }
            const buf = new Uint8Array(await res.arrayBuffer())
            Deno.writeFileSync(localPath, buf)
            return true
        } catch (_e) {
            return false
        }
    }

    // ── Capability flags ─────────────────────────────────────────────

    get supports() {
        return {
            reactions: true,
            inlineButtons: false,       // no interaction ack wiring yet
            htmlFormatting: false,      // lossy-converted to Markdown
            markdownFormatting: true,
            fileDownload: true,
            threads: false,
        }
    }

    // ── Private helpers ──────────────────────────────────────────────

    _assertStarted(method) {
        if (!this._started) {
            throw new Error(`DiscordBot: ${method}() called before start()`)
        }
    }
}
