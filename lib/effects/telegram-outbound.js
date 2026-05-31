/**
 * Chat outbound side effects.
 *
 * Effects go through `core.bot.*` first-class methods (sendText, sendFile,
 * editText, react, answerCallback) — the adapter in lib/bot/ hides the
 * platform-specific wire calls. All operations are wrapped in try/catch;
 * failures are logged via dbg() but never thrown, so a single bad
 * outbound message cannot crash the event loop.
 *
 * Hardening (platform-agnostic):
 *   - `assertSendable` refuses any file under STATE_DIR except the INBOX
 *     subdir. Prevents a compromised worker session from exfiltrating
 *     access.json, .env, logs, etc. by calling `reply` with a state path.
 *   - 50MB file size cap matching Telegram's document limit. Other
 *     platforms may tolerate more, but this is the conservative ceiling
 *     all current adapters can handle.
 *   - Text chunking at 4096 chars (Telegram's message cap). Chunks prefer
 *     paragraph → line → word boundaries. Discord allows 2000 but the
 *     chunker's output will just be further split by the adapter if
 *     needed — this ceiling matches the biggest supported platform.
 *
 * All text messages default to `format: "markdown"` per CLAUDE.md
 * (legacy Markdown — `*bold*`, `_italic_`, `` `code` ``, ` ```pre``` `,
 * `[text](url)`). Adapters that don't natively render Markdown
 * (e.g. DiscordBot) strip the formatting.
 */

import { versionedImport } from "../version.js"
import { SEPARATOR } from "../../imports.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { paths } = await versionedImport("../paths.js", import.meta)
const { buildOutboundMessagePatch } = await versionedImport("./telegram-state.js", import.meta)
const { loadAccess } = await versionedImport("../access.js", import.meta)
const { escapeMarkdown: esc } = await versionedImport("../pure/markdown.js", import.meta)

// Sentinel string that marks a message body as already carrying the
// verbose General-bound header (added either by handleReply or by us).
// Lets us avoid double-prepending when both paths fire on the same text.
const GENERAL_HEADER_SENTINEL = "landed in General"

/**
 * Outbound-layer guard: if the message is going to the CC group's General
 * topic (chatId == ccChatId AND no threadId), prepend a verbose header
 * identifying the source session. Defense-in-depth — handleReply already
 * adds this for the agent reply tool, but other emitters (system messages,
 * commands, etc.) bypass that path. Without this guard, anything landing
 * in General is anonymous-from-the-user's-POV.
 *
 * Idempotent: skips if the text already carries the sentinel.
 *
 * Pure-ish: reads access.json and core state but no other side effects.
 */
export function maybePrependGeneralHeader(text, chatId, threadId, recordAs, options, core) {
    const access = loadAccess()
    const ccChatId = access.commandCenterChatId
    if (!ccChatId || String(chatId) !== String(ccChatId)) { return text }
    if (threadId != null) { return text }   // going to a topic, not General
    if (typeof text !== "string" || text.length === 0) { return text }
    if (text.includes(GENERAL_HEADER_SENTINEL)) { return text }

    const isMd = options?.parse_mode === "Markdown" || options?.format === "markdown"
    const sessionId = recordAs?.sessionId ?? null
    const session = sessionId ? core?.chatSessions?.[sessionId] : null
    const cc = core?.chatState?.commandCenter ?? {}
    const sessionThreadId = sessionId ? cc.topicMap?.[sessionId] : null
    const topicName = sessionThreadId ? cc.topicNames?.[sessionThreadId] : null
    const title = typeof session?.title === "string" ? session.title : null
    const cwd = typeof session?.cwd === "string" ? session.cwd : null
    const gitBranch = typeof session?.gitBranch === "string" ? session.gitBranch : null
    const pid = session?.pid

    const lines = []
    if (sessionId) {
        const titlePart = title && title !== sessionId ? ` ${isMd ? `_${esc(title)}_` : `(${title})`}` : ""
        lines.push(isMd ? `*/chat_${sessionId}*${titlePart}` : `/chat_${sessionId}${titlePart}`)
    } else {
        lines.push(isMd ? "*(no session source recorded)*" : "(no session source recorded)")
    }
    if (topicName) { lines.push(isMd ? `topic: \`${topicName}\`` : `topic: ${topicName}`) }
    if (cwd) { lines.push(isMd ? `cwd: \`${cwd}\`` : `cwd: ${cwd}`) }
    if (gitBranch) { lines.push(isMd ? `branch: \`${gitBranch}\`` : `branch: ${gitBranch}`) }
    if (pid) { lines.push(`pid: ${pid}`) }
    lines.push(isMd ? `⚠️ _${GENERAL_HEADER_SENTINEL} — no topic thread bound_` : `(${GENERAL_HEADER_SENTINEL} — no topic thread bound)`)

    return lines.join("\n") + "\n\n" + text
}

// Outbound limits
const MAX_MESSAGE_CHARS = 4096
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024

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

/**
 * Translate a legacy `options = { parse_mode: "Markdown", reply_markup: InlineKeyboard, ... }`
 * Grammy bag into the abstract `SendOptions` shape. Accepts both —
 * existing callers that pass `{ parse_mode: "Markdown" }` don't need to
 * change, and new callers can pass `{ format: "markdown" }` directly.
 * Default format is "markdown" (legacy) per CLAUDE.md.
 */
function toAbstractOptions(options) {
    if (!options) { return { format: "markdown" } }
    if (options.format || options.buttons) {
        // Already in abstract shape.
        return options
    }
    const out = { format: "markdown" }
    if (options.parse_mode === "Markdown") { out.format = "markdown" }
    else if (options.parse_mode === "MarkdownV2") { out.format = "markdownv2" }
    else if (options.parse_mode === "HTML") { out.format = "html" }
    else if (options.parse_mode == null) { out.format = "plain" }
    // Pass reply_markup through as-is (TelegramBot._toGrammyOptions
    // accepts unknown fields verbatim). Same for reply_parameters and
    // message_thread_id (for forum topic routing).
    if (options.reply_markup) { out.reply_markup = options.reply_markup }
    if (options.reply_parameters) { out.reply_parameters = options.reply_parameters }
    if (options.message_thread_id != null) { out.threadId = options.message_thread_id }
    return out
}

export async function sendTextMessageToUser(effect, core) {
    const { text, options, recordAs, stashCriticMessageIdOnTask } = effect
    if (!core.bot) {
        dbg("TG-OUT", "no bot")
        return
    }
    if (typeof text !== "string" || text.length === 0) {
        dbg("TG-OUT", "empty text, skipping")
        return
    }

    // replyTo is the canonical source for chatId + threadId.
    let chatId = effect.chatId
    let replyToThreadId = null
    if (effect.replyTo) {
        chatId = effect.replyTo.chatId
        replyToThreadId = effect.replyTo.threadId
    } else {
        dbg("TG-OUT", `DEPRECATED: send_text_to_user missing replyTo (chatId=${chatId}, text=${(text ?? "").slice(0, 60)})`)
    }

    const sendOptions = toAbstractOptions(options)
    // replyTo threadId takes precedence over options.message_thread_id
    if (replyToThreadId != null) {
        sendOptions.threadId = replyToThreadId
    }
    // Outbound-layer guard: if this is going to the CC group's General
    // topic, ensure the user can see who sent it. Idempotent — skips
    // when handleReply already added the verbose header.
    const finalThreadId = sendOptions.threadId ?? options?.message_thread_id ?? null
    const guardedText = maybePrependGeneralHeader(text, chatId, finalThreadId, recordAs, options, core)
    const chunks = chunk(guardedText, MAX_MESSAGE_CHARS, "newline")
    const entries = []
    let firstMessageId = null
    for (const piece of chunks) {
        let sent
        try {
            sent = await core.bot.sendText(chatId, piece, sendOptions)
        } catch (e) {
            sent = await _recoverFailedSend(e, "sendText", core, chatId, piece, sendOptions)
            if (!sent) { continue }
        }
        if (sent?.messageId && firstMessageId == null) {
            firstMessageId = sent.messageId
        }
        if (recordAs && sent?.messageId) {
            entries.push({
                ...recordAs,
                id: sent.messageId,
                chatId,
                text: (recordAs.text ?? piece).slice(0, 500),
            })
        }
    }
    // Effect return-value pathway: onEvent merges this patch via
    // applyStateChanges after the effect resolves. See the effect
    // loop in lib/main-event-processor.js for the contract.
    const outboundPatch = buildOutboundMessagePatch(core, entries)

    // Optional: also stash the first-chunk message id on a long-task
    // entry so the critic-verdict handler can edit this message later
    // instead of sending a new one. Used by claude-hook-stop.js for
    // the "Critic running on <id>…" message.
    let criticStashPatch = null
    if (stashCriticMessageIdOnTask && firstMessageId != null) {
        const { chatId: stashChatId, taskId } = stashCriticMessageIdOnTask
        if (stashChatId != null && typeof taskId === "string") {
            criticStashPatch = {
                specialData: {
                    longTaskByChatId: {
                        [String(stashChatId)]: {
                            [taskId]: {
                                criticRunningMessageId: firstMessageId,
                                criticRunningChatId: String(stashChatId),
                            },
                        },
                    },
                },
            }
        }
    }

    // Merge outbound-record + critic-stash patches if both are present.
    // Both share `specialData` at the top level so the merge is just a
    // shallow join — mergeSessionData handles the deeper nesting.
    let patch = outboundPatch
    if (criticStashPatch) {
        if (patch) {
            patch = {
                ...patch,
                specialData: {
                    ...(patch.specialData ?? {}),
                    ...criticStashPatch.specialData,
                    // If both touch longTaskByChatId we need to merge
                    // inside it too — the outbound patch only writes to
                    // telegramMessagesByChatId so that can't happen
                    // today, but this defense is cheap.
                    ...(patch.specialData?.longTaskByChatId || criticStashPatch.specialData.longTaskByChatId
                        ? {
                            longTaskByChatId: {
                                ...(patch.specialData?.longTaskByChatId ?? {}),
                                ...criticStashPatch.specialData.longTaskByChatId,
                            },
                        }
                        : {}),
                },
            }
        } else {
            patch = criticStashPatch
        }
    }
    return patch ? { stateChanges: patch } : undefined
}

export async function sendFileToUser(effect, core) {
    const { filePath, filename, caption, recordAs, options } = effect
    if (!core.bot) {
        dbg("TG-OUT", "no bot")
        return
    }

    // replyTo is the canonical source for chatId + threadId.
    let chatId = effect.chatId
    let replyToThreadId = null
    if (effect.replyTo) {
        chatId = effect.replyTo.chatId
        replyToThreadId = effect.replyTo.threadId
    } else {
        dbg("TG-OUT", `DEPRECATED: send_file_to_user missing replyTo (chatId=${chatId})`)
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

    // Enforce the 50MB upload cap.
    let size
    try {
        size = Deno.statSync(filePath).size
    } catch (e) {
        dbg("TG-OUT", `sendFileToUser: stat failed for ${filePath}:`, e)
        return
    }
    if (size > MAX_DOCUMENT_BYTES) {
        const sizeMb = (size / 1024 / 1024).toFixed(1)
        dbg("TG-OUT", `sendFileToUser: ${filePath} is ${sizeMb}MB; capped at 50MB — skipping`)
        return
    }

    // Build fileOpts outside the try so the catch block can read them.
    const finalThreadId = replyToThreadId ?? options?.message_thread_id ?? null
    const guardedCaption = caption
        ? maybePrependGeneralHeader(caption, chatId, finalThreadId, recordAs, { parse_mode: "Markdown" }, core)
        : caption
    const fileOpts = {
        filename,
        caption: guardedCaption,
        format: guardedCaption ? "markdown" : undefined,
    }
    // replyTo threadId takes precedence, fall back to legacy options
    if (replyToThreadId != null) {
        fileOpts.threadId = replyToThreadId
    } else if (options?.message_thread_id != null) {
        fileOpts.threadId = options.message_thread_id
    }

    let sent
    try {
        sent = await core.bot.sendFile(chatId, filePath, fileOpts)
    } catch (e) {
        const underlying = e?.error ?? e?.cause
        dbg("TG-OUT", `sendFile failed (code=${e?.error_code} parse=${_isParseError(e)}): ${e?.description ?? e?.message}${underlying ? ` [underlying: ${underlying?.code ?? underlying?.name ?? ""} ${underlying?.message ?? String(underlying)}]` : ""}`)
        // Parse error in caption: retry without Markdown formatting on the caption.
        if (_isParseError(e) && guardedCaption) {
            try {
                const fallbackFileOpts = { ...fileOpts, format: undefined }
                sent = await core.bot.sendFile(chatId, filePath, fallbackFileOpts)
                dbg("TG-OUT", `sendFile recovered via plain-caption retry`)
            } catch (e2) {
                dbg("TG-OUT", `sendFile plain-caption retry also failed:`, e2)
                await _notifyDeliveryFailure("sendFile", core, chatId, fileOpts.threadId ?? null, e, `(file: ${filename ?? filePath})`)
            }
        } else {
            await _notifyDeliveryFailure("sendFile", core, chatId, fileOpts.threadId ?? null, e, `(file: ${filename ?? filePath})`)
        }
    }
    if (recordAs && sent?.messageId) {
        const patch = buildOutboundMessagePatch(core, [{
            ...recordAs,
            id: sent.messageId,
            chatId,
            text: (recordAs.text ?? caption ?? `(file: ${filename ?? filePath})`).slice(0, 500),
        }])
        return patch ? { stateChanges: patch } : undefined
    }
}

export async function sendReaction(effect, core) {
    const { chatId, messageId, emoji } = effect
    if (!core.bot) {
        dbg("TG-OUT", "no bot")
        return
    }
    if (!core.bot.supports?.reactions) {
        dbg("TG-OUT", "bot doesn't support reactions — skipping")
        return
    }
    try {
        await core.bot.react(chatId, messageId, emoji)
    } catch (e) {
        dbg("TG-OUT", "react failed:", e)
    }
}

export async function answerCallbackQuery(effect, core) {
    const { queryId, text } = effect
    if (!core.bot) {
        dbg("TG-OUT", "no bot")
        return
    }
    try {
        await core.bot.answerCallback(queryId, text)
    } catch (e) {
        dbg("TG-OUT", "answerCallback failed:", e)
    }
}

export async function editTelegramMessage(effect, core) {
    const { chatId, messageId, text, options } = effect
    if (!core.bot) {
        dbg("TG-OUT", "no bot")
        return
    }
    const editOpts = toAbstractOptions(options)
    try {
        await core.bot.editText(chatId, messageId, text, editOpts)
    } catch (e) {
        const underlying = e?.error ?? e?.cause
        dbg("TG-OUT", `editText failed (code=${e?.error_code} parse=${_isParseError(e)}): ${e?.description ?? e?.message}${underlying ? ` [underlying: ${underlying?.code ?? underlying?.name ?? ""} ${underlying?.message ?? String(underlying)}]` : ""}`)
        if (_isParseError(e)) {
            const fallback = { ...editOpts }
            delete fallback.parse_mode
            delete fallback.format
            try {
                await core.bot.editText(chatId, messageId, text, fallback)
                dbg("TG-OUT", "editText recovered via plain-text retry")
                return
            } catch (e2) {
                dbg("TG-OUT", "editText plain-text retry also failed:", e2)
            }
        }
        // Edits to messages that no longer exist (or chat-blocked) are
        // expected: don't bother notifying for "message to edit not found".
        const desc = String(e?.description ?? e?.message ?? "")
        if (/message to edit not found|message is not modified/i.test(desc)) {
            return
        }
        await _notifyDeliveryFailure("editText", core, chatId, editOpts?.threadId ?? null, e, text)
    }
}

// ── Thread / Forum Topic effects ─────────────────────────────────────

/**
 * Create a forum topic in a supergroup. Returns a state patch that
 * updates the command center topicMap/threadMap with the new binding.
 *
 * effect: { chatId, title, sessionId }
 */
export async function createThread(effect, core) {
    const { chatId, title, sessionId } = effect
    if (!core.bot) {
        dbg("TG-OUT", "no bot for createThread")
        return
    }
    if (!core.bot.supports?.threads) {
        dbg("TG-OUT", "bot doesn't support threads — skipping createThread")
        return
    }
    let result
    try {
        result = await core.bot.createThread(chatId, title)
    } catch (e) {
        dbg("TG-OUT", "createThread failed:", e)
        return
    }
    if (!result?.threadId) {
        dbg("TG-OUT", "createThread returned no threadId")
        return
    }
    const threadKey = String(result.threadId)
    dbg("TG-OUT", `created topic "${title}" → thread ${threadKey} for session ${sessionId}`)

    // Return a state patch to bind session ↔ topic
    if (sessionId) {
        const cc = core.chatState?.commandCenter ?? {}
        const topicMap = { ...(cc.topicMap ?? {}), [sessionId]: threadKey }
        const threadMap = { ...(cc.threadMap ?? {}), [threadKey]: sessionId }
        return {
            stateChanges: {
                chatState: {
                    commandCenter: { ...cc, topicMap, threadMap },
                },
            },
        }
    }
}

/**
 * Delete a forum topic from a supergroup.
 *
 * effect: { chatId, threadId }
 */
export async function deleteThread(effect, core) {
    const { chatId, threadId } = effect
    if (!core.bot) {
        dbg("TG-OUT", "no bot for deleteThread")
        return
    }
    if (!core.bot.supports?.threads) {
        dbg("TG-OUT", "bot doesn't support threads — skipping deleteThread")
        return
    }
    try {
        await core.bot.deleteThread(chatId, threadId)
        dbg("TG-OUT", `deleted topic ${threadId} in ${chatId}`)
    } catch (e) {
        dbg("TG-OUT", "deleteThread failed:", e)
    }
}

/**
 * Rename a forum topic in a supergroup.
 *
 * effect: { chatId, threadId, title }
 */
export async function renameThread(effect, core) {
    const { chatId, threadId, title } = effect
    if (!core.bot) {
        dbg("TG-OUT", "no bot for renameThread")
        return
    }
    if (!core.bot.supports?.threads) {
        dbg("TG-OUT", "bot doesn't support threads — skipping renameThread")
        return
    }
    try {
        await core.bot.renameThread(chatId, threadId, title)
        dbg("TG-OUT", `renamed topic ${threadId} to "${title}"`)
    } catch (e) {
        dbg("TG-OUT", "renameThread failed:", e)
    }
}

// ── Catch-all delivery-failure recovery ─────────────────────────────
//
// All outbound paths (sendText, sendFile, editText) share two failure
// shapes:
//
//   1. Markdown parse errors (400 "can't parse entities") — agent body
//      contains unbalanced `*`, `_`, `` ` ``, or `[` that confuses
//      Telegram's parser. Retry with parse_mode/format stripped.
//
//   2. Anything else (network, 403, 500, parse-retry that itself
//      failed) — post a single plain-text "[X delivery failed: …]
//      preview: …" notice in the same chat so the user isn't left
//      wondering why an agent went silent. If even the notice send
//      fails, log and give up.
//
// Two helpers — `_isParseError` for the discriminator, and
// `_notifyDeliveryFailure` for the user-visible alert. Each path
// composes them with its own retry shape (sendText resends the same
// text, sendFile resends with a stripped caption, editText resends
// the edit body).

function _isParseError(error) {
    const desc = String(error?.description ?? error?.message ?? "")
    return error?.error_code === 400
        && /can't parse entities|parse entities|Unsupported start tag/i.test(desc)
}

async function _notifyDeliveryFailure(label, core, chatId, threadId, error, bodyPreview) {
    const desc = String(error?.description ?? error?.message ?? "").slice(0, 200)
    try {
        const previewClean = String(bodyPreview ?? "").replace(/\s+/g, " ").slice(0, 120)
        const ellipsis = (bodyPreview?.length ?? 0) > 120 ? "…" : ""
        const notice = previewClean
            ? `[${label} delivery failed: ${desc}]\nbody preview: ${previewClean}${ellipsis}`
            : `[${label} delivery failed: ${desc}]`
        const noticeOpts = {}
        if (threadId != null) { noticeOpts.threadId = threadId }
        await core.bot.sendText(chatId, notice, noticeOpts)
        dbg("TG-OUT", `${label} delivery-failure notice sent to chat ${chatId}`)
    } catch (e) {
        dbg("TG-OUT", `${label} failure-notice send also failed (giving up):`, e)
    }
}

/**
 * sendText-specific recovery: parse-error retry, then notice fallback.
 * Returns the same `{ messageId }` shape on success, or null otherwise.
 */
async function _recoverFailedSend(originalError, label, core, chatId, piece, sendOptions) {
    const underlying = originalError?.error ?? originalError?.cause
    dbg("TG-OUT", `${label} failed (code=${originalError?.error_code} parse=${_isParseError(originalError)}): ${originalError?.description ?? originalError?.message}${underlying ? ` [underlying: ${underlying?.code ?? underlying?.name ?? ""} ${underlying?.message ?? String(underlying)}]` : ""}`)

    if (_isParseError(originalError)) {
        const fallback = { ...sendOptions }
        delete fallback.parse_mode
        delete fallback.format
        try {
            const sent = await core.bot.sendText(chatId, piece, fallback)
            dbg("TG-OUT", `${label} recovered via plain-text retry`)
            return sent
        } catch (e) {
            dbg("TG-OUT", `${label} plain-text retry also failed:`, e)
        }
    }

    await _notifyDeliveryFailure(label, core, chatId, sendOptions?.threadId ?? null, originalError, piece)
    return null
}
