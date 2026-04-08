/**
 * Telegram Bot API operations: reply, react, edit, download.
 * Used by the standalone server to execute tool calls on behalf of shims.
 */

import { extname, SEPARATOR, InputFile } from "../imports.js"
import { assertAllowedChat, loadAccess } from "./access.js"
import { STATE_DIR, INBOX_DIR } from "./protocol.js"

const MAX_CHUNK_LIMIT = 4096
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
const PHOTO_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"])

function assertSendable(f) {
    let real, stateReal
    try {
        real = Deno.realPathSync(f)
        stateReal = Deno.realPathSync(STATE_DIR)
    } catch {
        return
    }
    const inbox = `${stateReal}/inbox`
    if (real.startsWith(stateReal + SEPARATOR) && !real.startsWith(inbox + SEPARATOR)) {
        throw new Error(`refusing to send channel state: ${f}`)
    }
}

export function chunk(text, limit, mode) {
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
    return out
}

/**
 * Create a tool executor bound to a specific bot instance.
 * The executor handles reply, react, edit_message, download_attachment.
 */
export function createToolExecutor(bot, token, staticAccess, onReplyCallback) {
    return async (name, args) => {
        try {
            switch (name) {
                case "reply": {
                    const chat_id = args.chat_id
                    const text = args.text
                    const reply_to = args.reply_to != null ? Number(args.reply_to) : undefined
                    const files = args.files ?? []
                    const format = args.format ?? "text"
                    const parseMode = format === "markdownv2" ? "MarkdownV2" : undefined

                    assertAllowedChat(chat_id, staticAccess)

                    for (const f of files) {
                        assertSendable(f)
                        const st = Deno.statSync(f)
                        if (st.size > MAX_ATTACHMENT_BYTES) {
                            throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`)
                        }
                    }

                    const access = loadAccess(staticAccess)
                    const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
                    const mode = access.chunkMode ?? "length"
                    const replyMode = access.replyToMode ?? "first"
                    const chunks = chunk(text, limit, mode)
                    const sentIds = []

                    try {
                        for (const [i, chunkText] of chunks.entries()) {
                            const shouldReplyTo =
                                reply_to != null &&
                                replyMode !== "off" &&
                                (replyMode === "all" || i === 0)
                            const sent = await bot.api.sendMessage(chat_id, chunkText, {
                                ...(shouldReplyTo ? { reply_parameters: { message_id: reply_to } } : {}),
                                ...(parseMode ? { parse_mode: parseMode } : {}),
                            })
                            sentIds.push(sent.message_id)
                        }
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err)
                        throw new Error(`reply failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${msg}`)
                    }

                    for (const f of files) {
                        const ext = extname(f).toLowerCase()
                        const input = new InputFile(f)
                        const opts = reply_to != null && replyMode !== "off"
                            ? { reply_parameters: { message_id: reply_to } }
                            : undefined
                        if (PHOTO_EXTS.has(ext)) {
                            const sent = await bot.api.sendPhoto(chat_id, input, opts)
                            sentIds.push(sent.message_id)
                        } else {
                            const sent = await bot.api.sendDocument(chat_id, input, opts)
                            sentIds.push(sent.message_id)
                        }
                    }

                    if (onReplyCallback) {
                        try { await onReplyCallback(text, chat_id) } catch { /* ignore */ }
                    }

                    const result =
                        sentIds.length === 1
                            ? `sent (id: ${sentIds[0]})`
                            : `sent ${sentIds.length} parts (ids: ${sentIds.join(", ")})`
                    return { content: [{ type: "text", text: result }] }
                }

                case "react": {
                    assertAllowedChat(args.chat_id, staticAccess)
                    await bot.api.setMessageReaction(args.chat_id, Number(args.message_id), [
                        { type: "emoji", emoji: args.emoji },
                    ])
                    return { content: [{ type: "text", text: "reacted" }] }
                }

                case "download_attachment": {
                    const file_id = args.file_id
                    const file = await bot.api.getFile(file_id)
                    if (!file.file_path) {
                        throw new Error("Telegram returned no file_path — file may have expired")
                    }
                    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
                    const res = await fetch(url)
                    if (!res.ok) {
                        throw new Error(`download failed: HTTP ${res.status}`)
                    }
                    const buf = new Uint8Array(await res.arrayBuffer())
                    const rawExt = file.file_path.includes(".") ? file.file_path.split(".").pop() : "bin"
                    const ext = rawExt.replace(/[^a-zA-Z0-9]/g, "") || "bin"
                    const uniqueId = (file.file_unique_id ?? "").replace(/[^a-zA-Z0-9_-]/g, "") || "dl"
                    const path = `${INBOX_DIR}/${Date.now()}-${uniqueId}.${ext}`
                    Deno.mkdirSync(INBOX_DIR, { recursive: true })
                    Deno.writeFileSync(path, buf)
                    return { content: [{ type: "text", text: path }] }
                }

                case "edit_message": {
                    assertAllowedChat(args.chat_id, staticAccess)
                    const editFormat = args.format ?? "text"
                    const editParseMode = editFormat === "markdownv2" ? "MarkdownV2" : undefined
                    const edited = await bot.api.editMessageText(
                        args.chat_id,
                        Number(args.message_id),
                        args.text,
                        ...(editParseMode ? [{ parse_mode: editParseMode }] : []),
                    )
                    const id = typeof edited === "object" ? edited.message_id : args.message_id
                    return { content: [{ type: "text", text: `edited (id: ${id})` }] }
                }

                default:
                    return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true }
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            return { content: [{ type: "text", text: `${name} failed: ${msg}` }], isError: true }
        }
    }
}
