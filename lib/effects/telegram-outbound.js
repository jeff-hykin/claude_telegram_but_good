/**
 * Telegram outbound side effects.
 *
 * Each function receives the full effect object plus core (containing
 * the Grammy bot instance at core.bot). All operations are wrapped in
 * try/catch — failures are logged via dbg() but never thrown, so a single
 * bad outbound message cannot crash the event loop.
 *
 * Hardening:
 *   - `assertSendable` refuses any file under STATE_DIR except the INBOX
 *     subdir. Prevents a compromised worker session from exfiltrating
 *     access.json, .env, logs, etc. by calling `reply` with a state path.
 *   - 50MB file size cap (Telegram Bot API limit). Files over the cap
 *     are skipped with a logged error rather than a 413 from Telegram.
 *   - Text chunking at 4096 chars (Telegram's message cap). Chunks prefer
 *     paragraph → line → word boundaries.
 *   - Photo extensions (.jpg/.jpeg/.png/.gif/.webp) send via sendPhoto
 *     so they render inline; everything else sends as a document.
 *
 * All text messages default to parse_mode: "HTML" per CLAUDE.md.
 */

import { versionedImport } from "../version.js"
import { InputFile, SEPARATOR, extname } from "../../imports.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { paths } = await versionedImport("../paths.js", import.meta)
const { recordOutboundMessage } = await versionedImport("./telegram-state.js", import.meta)

// Telegram Bot API limits
const MAX_MESSAGE_CHARS = 4096
const TELEGRAM_MAX_DOCUMENT_BYTES = 50 * 1024 * 1024
const PHOTO_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"])

/**
 * Refuse to send a file that lives inside STATE_DIR (sockets, access.json,
 * logs, .env). Files under STATE_DIR/inbox are explicitly allowed because
 * that's where Telegram-received attachments land.
 *
 * If realPathSync fails (file doesn't exist, wrong permissions), we log and
 * return without throwing — the downstream sendDocument call will produce
 * a clearer error.
 */
function assertSendable(filePath) {
    let real, stateReal
    try {
        real = Deno.realPathSync(filePath)
    } catch (e) {
        dbg("TG-OUT", `assertSendable: realPath failed for ${filePath}:`, e)
        return
    }
    try {
        stateReal = Deno.realPathSync(paths.STATE_DIR)
    } catch (e) {
        dbg("TG-OUT", "assertSendable: STATE_DIR realPath failed:", e)
        return
    }
    const inbox = `${stateReal}${SEPARATOR}inbox`
    if (real.startsWith(stateReal + SEPARATOR) && !real.startsWith(inbox + SEPARATOR)) {
        throw new Error(`refusing to send channel state: ${filePath}`)
    }
}

/**
 * Split text into chunks that each fit within `limit`. Mode "newline"
 * prefers paragraph (\n\n), then line (\n), then word boundaries.
 *
 * Returns an array of strings, each <= limit chars.
 */
export function chunk(text, limit, mode = "newline") {
    if (text.length <= limit) {
        return [text]
    }
    const out = []
    let rest = text
    while (rest.length > limit) {
        let cut = limit
        if (mode === "newline") {
            const para = rest.lastIndexOf("\n\n", limit)
            const line = rest.lastIndexOf("\n", limit)
            const space = rest.lastIndexOf(" ", limit)
            cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
        }
        out.push(rest.slice(0, cut))
        rest = rest.slice(cut).replace(/^\n+/, "")
    }
    if (rest) {
        out.push(rest)
    }
    return out.filter(Boolean)
}

export async function sendTextMessageToUser(effect, core) {
    const { chatId, text, options = { parse_mode: "HTML" }, recordAs } = effect
    if (!core.bot) {
        dbg("TG-OUT", "no bot")
        return
    }
    if (typeof text !== "string" || text.length === 0) {
        dbg("TG-OUT", "empty text, skipping")
        return
    }
    const chunks = chunk(text, MAX_MESSAGE_CHARS, "newline")
    for (const piece of chunks) {
        let sent
        try {
            sent = await core.bot.api.sendMessage(chatId, piece, options)
        } catch (e) {
            dbg("TG-OUT", "sendMessage failed:", e)
            continue
        }
        if (recordAs && sent?.message_id != null) {
            recordOutboundMessage(core, {
                ...recordAs,
                id: sent.message_id,
                chatId,
                text: (recordAs.text ?? piece).slice(0, 500),
            })
        }
    }
}

export async function sendFileToUser(effect, core) {
    const { chatId, filePath, filename, caption, recordAs } = effect
    if (!core.bot) {
        dbg("TG-OUT", "no bot")
        return
    }
    if (!filePath || typeof filePath !== "string") {
        dbg("TG-OUT", "sendFileToUser: missing filePath")
        return
    }

    // SECURITY: refuse to send files from STATE_DIR (except INBOX).
    try {
        assertSendable(filePath)
    } catch (e) {
        dbg("TG-OUT", "sendFileToUser: refused path:", e)
        return
    }

    // Enforce Telegram's 50MB Bot API document cap.
    let size
    try {
        size = Deno.statSync(filePath).size
    } catch (e) {
        dbg("TG-OUT", `sendFileToUser: stat failed for ${filePath}:`, e)
        return
    }
    if (size > TELEGRAM_MAX_DOCUMENT_BYTES) {
        const sizeMb = (size / 1024 / 1024).toFixed(1)
        dbg("TG-OUT", `sendFileToUser: ${filePath} is ${sizeMb}MB; Telegram caps bot uploads at 50MB — skipping`)
        return
    }

    // Decide photo-vs-document by extension so JPEG/PNG render inline.
    const ext = extname(filePath).toLowerCase()
    const isPhoto = PHOTO_EXTS.has(ext)

    let sent
    try {
        const input = new InputFile(filePath, filename)
        const opts = {}
        if (caption) {
            opts.caption = caption
            opts.parse_mode = "HTML"
        }
        if (isPhoto) {
            sent = await core.bot.api.sendPhoto(chatId, input, opts)
        } else {
            sent = await core.bot.api.sendDocument(chatId, input, opts)
        }
    } catch (e) {
        dbg("TG-OUT", `send${isPhoto ? "Photo" : "Document"} failed:`, e)
    }
    if (recordAs && sent?.message_id != null) {
        recordOutboundMessage(core, {
            ...recordAs,
            id: sent.message_id,
            chatId,
            text: (recordAs.text ?? caption ?? `(file: ${filename ?? filePath})`).slice(0, 500),
        })
    }
}

export async function sendReaction(effect, core) {
    const { chatId, messageId, emoji } = effect
    if (!core.bot) {
        dbg("TG-OUT", "no bot")
        return
    }
    try {
        const reactions = emoji ? [{ type: "emoji", emoji }] : []
        await core.bot.api.setMessageReaction(chatId, messageId, reactions)
    } catch (e) {
        dbg("TG-OUT", "setMessageReaction failed:", e)
    }
}

export async function answerCallbackQuery(effect, core) {
    const { queryId, text } = effect
    if (!core.bot) {
        dbg("TG-OUT", "no bot")
        return
    }
    try {
        await core.bot.api.answerCallbackQuery(queryId, text ? { text } : undefined)
    } catch (e) {
        dbg("TG-OUT", "answerCallbackQuery failed:", e)
    }
}

export async function editTelegramMessage(effect, core) {
    const { chatId, messageId, text, options = { parse_mode: "HTML" } } = effect
    if (!core.bot) {
        dbg("TG-OUT", "no bot")
        return
    }
    try {
        await core.bot.api.editMessageText(chatId, messageId, text, options)
    } catch (e) {
        dbg("TG-OUT", "editMessageText failed:", e)
    }
}
