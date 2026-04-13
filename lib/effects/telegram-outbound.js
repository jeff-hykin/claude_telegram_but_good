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
 * All text messages default to `format: "html"` per CLAUDE.md. Adapters
 * that don't natively render HTML (e.g. DiscordBot) strip the tags.
 */

import { versionedImport } from "../version.js"
import { SEPARATOR } from "../../imports.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { paths } = await versionedImport("../paths.js", import.meta)
const { buildOutboundMessagePatch } = await versionedImport("./telegram-state.js", import.meta)

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
 * Translate a legacy `options = { parse_mode: "HTML", reply_markup: InlineKeyboard, ... }`
 * Grammy bag into the abstract `SendOptions` shape. Accepts both —
 * existing callers that pass `{ parse_mode: "HTML" }` don't need to
 * change overnight, and new callers can pass `{ format: "html" }`
 * directly. Returns undefined if `options` is nullish.
 */
function toAbstractOptions(options) {
    if (!options) { return { format: "html" } }
    if (options.format || options.buttons) {
        // Already in abstract shape.
        return options
    }
    const out = { format: "html" }
    if (options.parse_mode === "HTML") { out.format = "html" }
    else if (options.parse_mode === "MarkdownV2") { out.format = "markdown" }
    else if (options.parse_mode == null) { out.format = "plain" }
    // Pass reply_markup through as-is (TelegramBot._toGrammyOptions
    // accepts unknown fields verbatim). Same for reply_parameters.
    if (options.reply_markup) { out.reply_markup = options.reply_markup }
    if (options.reply_parameters) { out.reply_parameters = options.reply_parameters }
    return out
}

export async function sendTextMessageToUser(effect, core) {
    const { chatId, text, options, recordAs, stashCriticMessageIdOnTask } = effect
    if (!core.bot) {
        dbg("TG-OUT", "no bot")
        return
    }
    if (typeof text !== "string" || text.length === 0) {
        dbg("TG-OUT", "empty text, skipping")
        return
    }
    const sendOptions = toAbstractOptions(options)
    const chunks = chunk(text, MAX_MESSAGE_CHARS, "newline")
    const entries = []
    let firstMessageId = null
    for (const piece of chunks) {
        let sent
        try {
            sent = await core.bot.sendText(chatId, piece, sendOptions)
        } catch (e) {
            dbg("TG-OUT", "sendText failed:", e)
            continue
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

    let sent
    try {
        sent = await core.bot.sendFile(chatId, filePath, {
            filename,
            caption,
            format: caption ? "html" : undefined,
        })
    } catch (e) {
        dbg("TG-OUT", `sendFile failed:`, e)
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
    try {
        await core.bot.editText(chatId, messageId, text, toAbstractOptions(options))
    } catch (e) {
        dbg("TG-OUT", "editText failed:", e)
    }
}
