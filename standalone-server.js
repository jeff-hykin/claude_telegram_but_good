#!/usr/bin/env -S deno run -A
/**
 * Standalone Telegram server — owns the bot, runs independently of Claude Code.
 *
 * - Listens on IPC_SOCK for shim connections
 * - Routes Telegram messages to the focused session's shim
 * - Executes tool calls (reply/react/edit/download) on behalf of shims
 * - Handles hook events and sends status messages to Telegram
 * - Stays running when all Claude sessions close
 * - Manages PID file for lifecycle management
 */

import { Bot, GrammyError, InlineKeyboard, join, sibling } from "./imports.js"
import {
    HOME, STATE_DIR, IPC_SOCK, PID_FILE, INBOX_DIR, CUSTOM_COMMANDS_DIR,
    ACCESS_FILE,
    sendIpc, parseIpcMessages, dbg, logMessage,
    randomHex, execSync, getPluginVersion,
    UNKNOWN_CLAUDE_PID,
} from "./lib/protocol.js"
import {
    loadAccess, readAccessFile, saveAccess, gate, checkApprovals,
    assertAllowedChat,
} from "./lib/access.js"
import { loadCommands, getHotCommands, getRandomTip, getCommandDescriptions } from "./lib/commands.js"
import { createToolExecutor } from "./lib/telegram-api.js"
import {
    formatPreToolUse, formatPostToolUse,
    setActiveToolMessage, getActiveToolMessage, clearActiveToolMessage,
    getLastHookMessage, setLastHookMessage, clearLastHookMessage,
    appendHookItem, replaceLastHookItem,
} from "./lib/hooks.js"
import { getBotToken } from "./lib/config.js"
import { generateName } from "./lib/names.js"
import {
    recordInbound as trackerRecordInbound,
    recordOutbound as trackerRecordOutbound,
    isPending as trackerIsPending,
    getEntry as trackerGetEntry,
    markNudged as trackerMarkNudged,
    dropSession as trackerDropSession,
} from "./lib/message-tracker.js"
import { createIdleDetector } from "./lib/idle-detector.js"
import {
    rebuildIndex, restoreDefinitionsFromDisk, findActiveTaskForSession,
    readTask, updateTask, cancelTask, getDefinition, taskPath,
    appendLog, storeDefinition,
} from "./lib/long-task.js"
import { startHttpServer, getHttpPort } from "./lib/long-task-http.js"
import { runCritic, processVerdict } from "./lib/long-task-critic.js"

// Log uncaught errors to the log file so crashes are diagnosable
globalThis.addEventListener("unhandledrejection", (e) => {
    const err = e.reason
    const msg = err instanceof Error ? err.stack ?? err.message : String(err)
    dbg("FATAL", "unhandled rejection:", msg)
})
globalThis.addEventListener("error", (e) => {
    const msg = e.error instanceof Error ? e.error.stack ?? e.error.message : String(e.error ?? e.message)
    dbg("FATAL", "uncaught error:", msg)
})

// Fire-and-forget error handler for non-critical API calls. Usage: .catch(ff)
const ff = (e) => dbg("TG-API", "fire-and-forget failed:", e)

const PLUGIN_VERSION = getPluginVersion(import.meta)

const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? getBotToken()
const STATIC = Deno.env.get("TELEGRAM_ACCESS_MODE") === "static"

if (!TOKEN) {
    const enc = new TextEncoder()
    Deno.stderr.writeSync(enc.encode(
        "telegram server: TELEGRAM_BOT_TOKEN required\n" +
        "  set via: cbg config telegram_bot_token <token>\n" +
        "  or env: TELEGRAM_BOT_TOKEN=123456789:AAH...\n"
    ))
    Deno.exit(1)
}

dbg("SERVER", "starting standalone server, TOKEN set:", !!TOKEN, "STATIC:", STATIC)

// === Check for existing server ===
Deno.mkdirSync(STATE_DIR, { recursive: true })
try {
    const existingPid = parseInt(Deno.readTextFileSync(PID_FILE).trim())
    if (existingPid > 0 && existingPid !== Deno.pid) {
        const check = new Deno.Command("kill", {
            args: ["-0", String(existingPid)],
            stdout: "null",
            stderr: "null",
        }).outputSync()
        if (check.success) {
            dbg("SERVER", "another server is already running at PID", existingPid, "— exiting")
            Deno.exit(0)
        }
    }
} catch (e) {
    dbg("SERVER", "no existing pid file or not running:", e)
}

// === PID file ===
Deno.writeTextFileSync(PID_FILE, String(Deno.pid))

// === Session registry ===
const sessions = new Map()
let focusedSessionId = null
// /chat_<id> can race a new shim — remember the user's intent so the
// session gets focused as soon as it registers.
let pendingFocusId = null

const messageQueue = []
const MAX_QUEUE_SIZE = 50

function allSessions() {
    return Array.from(sessions.values()).map(s => s.info)
}

function setSessionTitle(sessionId, title) {
    const session = sessions.get(sessionId)
    if (session) {
        session.info.title = title
        return true
    }
    return false
}

function getSessionTitle(sessionId) {
    return sessions.get(sessionId)?.info.title
}

// === Bot ===
const bot = new Bot(TOKEN)
let botUsername = ""

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i
const pendingPermissions = new Map()  // request_id -> { tool_name, description, input_preview, sessionId, createdAt }
const pendingCommandErrors = new Map()  // errorId -> { cmdName, error, stack, text, createdAt }

// Sweep expired entries every 5 minutes
const PENDING_TTL_MS = 10 * 60 * 1000  // 10 min for permissions
const ERROR_TTL_MS = 30 * 60 * 1000    // 30 min for command errors
setInterval(() => {
    const now = Date.now()
    for (const [id, p] of pendingPermissions) {
        if (p.createdAt && now - p.createdAt > PENDING_TTL_MS) {
            pendingPermissions.delete(id)
        }
    }
    for (const [id, e] of pendingCommandErrors) {
        if (e.createdAt && now - e.createdAt > ERROR_TTL_MS) {
            pendingCommandErrors.delete(id)
        }
    }
}, 5 * 60 * 1000)

const BOOT_ACCESS = STATIC
    ? (() => {
        const a = readAccessFile()
        if (a.dmPolicy === "pairing") {
            Deno.stderr.writeSync(new TextEncoder().encode(
                'telegram server: static mode — dmPolicy "pairing" downgraded to "allowlist"\n'
            ))
            a.dmPolicy = "allowlist"
        }
        a.pending = {}
        return a
    })()
    : null

const toolExecutor = createToolExecutor(
    bot,
    TOKEN,
    BOOT_ACCESS,
    async (text, chat_id) => {
        const onReply = getHotCommands().get("__onReply")
        if (onReply) {
            try { await onReply({ text, chat_id }, bot, getCommandState()) } catch (e) { dbg("COMMANDS", "__onReply failed:", e) }
        }
    },
)

// === Commands ===
const COMMANDS_DIR = sibling(import.meta, "commands")
// CUSTOM_COMMANDS_DIR imported from protocol.js
dbg("HOT", `COMMANDS_DIR resolved to: ${COMMANDS_DIR}`)
dbg("HOT", `CUSTOM_COMMANDS_DIR resolved to: ${CUSTOM_COMMANDS_DIR}`)
dbg("HOT", `import.meta.url: ${import.meta.url}`)

function getCommandState() {
    return {
        allSessions,
        get focusedSessionId() { return focusedSessionId },
        setFocusedSession(id) { focusedSessionId = id },
        setSessionTitle,
        SESSION_ID: "server",
        get isPrimary() { return true },
        loadAccess: () => loadAccess(BOOT_ACCESS),
        secondaries: sessions,
        SESSION_PID: Deno.pid,
        SESSION_CWD: Deno.cwd(),
        deliverToFocused,
        sendIpc,
        bot,
        mcp: null,
        dbg,
        letClaudeHandle: (ctx, text) => {
            const content = text ?? ctx.message?.text ?? ""
            const from = ctx.from
            const chat_id = String(ctx.chat.id)
            const msgId = ctx.message?.message_id
            const meta = {
                chat_id,
                ...(msgId != null ? { message_id: String(msgId) } : {}),
                user: from.username ?? String(from.id),
                user_id: String(from.id),
                ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
            }
            deliverToFocused(content, meta)
        },
        execSync,
        randomHex,
        generateName,
        homedir: () => HOME,
        STATE_DIR,
        ACCESS_FILE,
        CUSTOM_COMMANDS_DIR,
        PLUGIN_VERSION,
    }
}

// Descriptions for commands registered directly on `bot` (not loaded from commands/).
const BUILTIN_DESCRIPTIONS = {
    reload: "Hot-reload command handlers",
}

async function publishCommandMenu() {
    if (!bot?.api) {
        return
    }
    if (initialLoadPromise) {
        await initialLoadPromise
    }
    const merged = new Map(Object.entries(BUILTIN_DESCRIPTIONS))
    for (const [name, desc] of getCommandDescriptions()) {
        merged.set(name, desc)
    }
    const entries = []
    for (const [name, desc] of merged) {
        if (/^[a-z][a-z0-9_]{0,31}$/.test(name)) {
            entries.push({ command: name, description: desc.slice(0, 256) })
        }
    }
    entries.sort((a, b) => a.command.localeCompare(b.command))
    try {
        await bot.api.setMyCommands(entries, { scope: { type: "all_private_chats" } })
        dbg("COMMANDS", `published ${entries.length} commands to Telegram menu`)
    } catch (e) {
        dbg("COMMANDS", "setMyCommands failed:", e)
    }
}

let initialLoadPromise = loadCommands(COMMANDS_DIR, CUSTOM_COMMANDS_DIR).catch((err) => { dbg("HOT", "loadCommands FAILED:", err) })

// === Message delivery ===

function truncMsg(text, max = 50) {
    if (text.length <= max) {
        return text
    }
    return text.slice(0, max - 3) + "..."
}

function pushRecentMessage(session, role, text) {
    if (!session.info.recentMessages) {
        session.info.recentMessages = []
    }
    session.info.recentMessages.push({ role, text: truncMsg(text) })
    // Keep only the last 2
    if (session.info.recentMessages.length > 2) {
        session.info.recentMessages.shift()
    }
}

function deliverToSession(sessionId, content, meta) {
    const session = sessions.get(sessionId)
    if (!session) {
        return false
    }
    session.info.lastActive = Date.now()
    pushRecentMessage(session, "human", content)
    sendIpc(session.conn, { type: "channel_event", content, meta })
    if (meta?.message_id != null) {
        trackerRecordInbound(sessionId, { messageId: meta.message_id, chatId: meta.chat_id, text: content })
    }
    return true
}

function queueMessage(content, meta) {
    messageQueue.push({ content, meta })
    if (messageQueue.length > MAX_QUEUE_SIZE) {
        messageQueue.shift()
    }
    dbg("QUEUE", "queued message, queue size:", messageQueue.length)
}

function deliverToFocused(content, meta) {
    if (!focusedSessionId) {
        queueMessage(content, meta)
        return false
    }
    let session = sessions.get(focusedSessionId)
    if (!session) {
        // Focused session is gone — pick another one if available
        focusedSessionId = sessions.size > 0 ? sessions.keys().next().value : null
        session = focusedSessionId ? sessions.get(focusedSessionId) : null
    }
    if (!session) {
        queueMessage(content, meta)
        return false
    }
    session.info.lastActive = Date.now()
    pushRecentMessage(session, "human", content)
    sendIpc(session.conn, { type: "channel_event", content, meta })
    if (meta?.message_id != null) {
        trackerRecordInbound(focusedSessionId, { messageId: meta.message_id, chatId: meta.chat_id, text: content })
    }
    return true
}

function drainQueue(sessionId) {
    const session = sessions.get(sessionId)
    if (!session || messageQueue.length === 0) {
        return
    }
    dbg("QUEUE", "draining", messageQueue.length, "queued messages to", sessionId)
    while (messageQueue.length > 0) {
        const msg = messageQueue.shift()
        sendIpc(session.conn, { type: "channel_event", content: msg.content, meta: msg.meta })
    }
}

// === IPC Server ===

function handleShimMessage(conn, msg) {
    switch (msg.type) {
        case "register": {
            const info = msg.session
            dbg("IPC", "session registered:", info.id, "pid:", info.pid, "cwd:", info.cwd)
            sessions.set(info.id, { conn, info })
            Deno.stderr.writeSync(new TextEncoder().encode(
                `telegram server: session ${info.id} connected (PID ${info.pid}, ${info.cwd})\n`
            ))

            if (pendingFocusId === info.id) {
                focusedSessionId = info.id
                pendingFocusId = null
                dbg("IPC", "applied pending focus to session:", info.id)
            } else if (!focusedSessionId) {
                focusedSessionId = info.id
                dbg("IPC", "auto-focused session:", info.id)
            }

            sendIpc(conn, {
                type: "registered",
                sessions: allSessions(),
                focusedId: focusedSessionId ?? info.id,
            })

            if (focusedSessionId === info.id) {
                drainQueue(info.id)
            }
            break
        }

        case "unregister": {
            dbg("IPC", "session unregistered:", msg.sessionId)
            sessions.delete(msg.sessionId)
            trackerDropSession(msg.sessionId)
            if (focusedSessionId === msg.sessionId) {
                focusedSessionId = sessions.size > 0 ? sessions.keys().next().value : null
            }
            break
        }

        case "set_title": {
            setSessionTitle(msg.sessionId, msg.title)
            dbg("IPC", "title set:", msg.sessionId, msg.title)
            break
        }

        case "permission_request": {
            const { request_id, tool_name, description, input_preview } = msg
            // Track which session originated this request so replies go to the right place
            const originSessionId = [...sessions.entries()].find(([, s]) => s.conn === conn)?.[0] ?? focusedSessionId
            pendingPermissions.set(request_id, { tool_name, description, input_preview, sessionId: originSessionId, createdAt: Date.now() })
            const access = loadAccess(BOOT_ACCESS)
            const text = `\uD83D\uDD10 Permission: ${tool_name}`
            const keyboard = new InlineKeyboard()
                .text("See more", `perm:more:${request_id}`)
                .text("\u2705 Allow", `perm:allow:${request_id}`)
                .text("\u274C Deny", `perm:deny:${request_id}`)
            for (const chat_id of access.allowFrom) {
                void bot.api.sendMessage(chat_id, text, { reply_markup: keyboard }).catch((e) => {
                    Deno.stderr.writeSync(new TextEncoder().encode(
                        `permission_request send to ${chat_id} failed: ${e}\n`
                    ))
                })
            }
            break
        }

        case "permission_reply": {
            // Route to the session that originated the request, not just the focused one
            const perm = pendingPermissions.get(msg.request_id)
            const targetId = perm?.sessionId ?? focusedSessionId
            const target = sessions.get(targetId ?? "")
            if (target) {
                sendIpc(target.conn, { type: "permission_reply", request_id: msg.request_id, behavior: msg.behavior })
            }
            break
        }

        case "tool_request": {
            const { requestId, sessionId, name, args } = msg

            if (name === "reply" && args.text && sessionId) {
                args.text = `/chat_${sessionId}\n${args.text}`
            }

            void (async () => {
                if (name === "reload") {
                    const { loaded, errors } = await loadCommands(COMMANDS_DIR, CUSTOM_COMMANDS_DIR)
                    publishCommandMenu()
                    const parts = [`Reloaded: ${loaded} command(s)`]
                    if (errors.length > 0) {
                        parts.push(`\nErrors:\n${errors.join("\n")}`)
                    }
                    sendIpc(conn, { type: "tool_response", requestId, result: { content: [{ type: "text", text: parts.join("") }] } })
                    return
                }

                if (name === "new_command") {
                    const filename = args.filename
                    const code = args.code
                    if (!filename.endsWith(".js")) {
                        sendIpc(conn, { type: "tool_response", requestId, result: { content: [{ type: "text", text: "Error: filename must end in .js" }] } })
                        return
                    }
                    Deno.mkdirSync(CUSTOM_COMMANDS_DIR, { recursive: true })
                    Deno.writeTextFileSync(join(CUSTOM_COMMANDS_DIR, filename), code)
                    const { loaded, errors } = await loadCommands(COMMANDS_DIR, CUSTOM_COMMANDS_DIR)
                    publishCommandMenu()
                    const parts = [`Wrote ${join(CUSTOM_COMMANDS_DIR, filename)}\nReloaded: ${loaded} command(s)`]
                    if (errors.length > 0) {
                        parts.push(`\nErrors:\n${errors.join("\n")}`)
                    }
                    sendIpc(conn, { type: "tool_response", requestId, result: { content: [{ type: "text", text: parts.join("") }] } })
                    return
                }

                const result = await toolExecutor(name, args)

                // Track last reply text per session (strip the /chat_ header)
                if (name === "reply" && !result.isError && sessionId) {
                    const session = sessions.get(sessionId)
                    const raw = args.text ?? ""
                    const stripped = raw.replace(/^\/chat_[a-zA-Z0-9_]+\n/, "")
                    if (session) {
                        pushRecentMessage(session, "bot", stripped)
                    }
                    trackerRecordOutbound(sessionId, { text: stripped })
                }

                sendIpc(conn, { type: "tool_response", requestId, result })
            })()
            break
        }

        case "hook_event": {
            // Update lastActive on any tool call activity
            const hookSession = sessions.get(msg.sessionId)
            if (hookSession) {
                hookSession.info.lastActive = Date.now()
            }
            void handleHookEvent(msg)
            break
        }
    }
}

// === Hook event handling ===

// Map Claude PID to shim session ID
const pidToShimSession = new Map()

async function handleHookEvent(msg) {
    // Stop hooks → idle detector, no Telegram formatting
    if (msg.hook === "Stop") {
        let stopShimId = msg.claudePid ? pidToShimSession.get(msg.claudePid) : undefined
        if (!stopShimId && msg.claudePid) {
            for (const [id, s] of sessions) {
                if (s.info.pid === msg.claudePid) {
                    stopShimId = id
                    pidToShimSession.set(msg.claudePid, id)
                    break
                }
            }
        }
        if (stopShimId) {
            idleDetector.onSessionStop(stopShimId)
        }
        return
    }

    // Fail-safe: hooks that couldn't determine their Claude PID send the
    // UNKNOWN sentinel. We display these unconditionally rather than dropping
    // them on the focused-session check, so a broken PID walk never silently
    // hides activity from the user.
    const isUnknown = msg.claudePid === UNKNOWN_CLAUDE_PID

    // Resolve Claude PID to shim session ID (skipped for UNKNOWN events)
    let shimId
    if (!isUnknown) {
        shimId = msg.claudePid ? pidToShimSession.get(msg.claudePid) : undefined
        if (!shimId && msg.claudePid) {
            // Look up by PID — shims register with the Claude process PID
            for (const [id, s] of sessions) {
                if (s.info.pid === msg.claudePid) {
                    shimId = id
                    pidToShimSession.set(msg.claudePid, id)
                    dbg("HOOK", `mapped Claude PID ${msg.claudePid} -> shim ${id}`)
                    break
                }
            }
        }
        if (!shimId) {
            dbg("HOOK", `no shim found for Claude PID ${msg.claudePid}, session ${msg.sessionId}`)
        }
    } else {
        dbg("HOOK", `UNKNOWN claudePid sentinel, session ${msg.sessionId} — using fail-safe display path`)
    }

    // Only show hooks from the focused session — bypassed for UNKNOWN events
    // so they always reach the user.
    if (!isUnknown && shimId !== focusedSessionId) return

    const access = loadAccess(BOOT_ACCESS)

    const MD = { parse_mode: "HTML" }

    async function sendOrEdit(chat_id, text) {
        const last = getLastHookMessage(chat_id)
        // If we already own a hook message for this session, scroll the
        // existing message instead of starting a new one. appendHookItem
        // handles the overflow by dropping items from the top.
        if (last && last.sessionId === msg.sessionId) {
            const items = appendHookItem(chat_id, msg.sessionId, text)
            const combined = items.join("\n")
            try {
                await bot.api.editMessageText(chat_id, last.messageId, combined, MD)
                setLastHookMessage(chat_id, last.messageId, items, msg.sessionId)
                return last.messageId
            } catch (e) {
                dbg("HOOK", "edit failed, sending new message:", e)
            }
        }
        // No existing hook message, or the edit failed — send a fresh one.
        try {
            const sent = await bot.api.sendMessage(chat_id, text, MD)
            setLastHookMessage(chat_id, sent.message_id, [text], msg.sessionId)
            return sent.message_id
        } catch (e) {
            dbg("HOOK", "sendMessage with markdown failed, retrying plain:", e)
            try {
                const sent = await bot.api.sendMessage(chat_id, text)
                setLastHookMessage(chat_id, sent.message_id, [text], msg.sessionId)
                return sent.message_id
            } catch (e2) { dbg("HOOK", "sendMessage plain also failed:", e2); return null }
        }
    }

    if (msg.hook === "PreToolUse") {
        const text = formatPreToolUse(msg)
        if (!text) return
        for (const chat_id of access.allowFrom) {
            const msgId = await sendOrEdit(chat_id, text)
            if (msgId) {
                setActiveToolMessage(msg.sessionId, msg.tool_name, chat_id, msgId)
            }
        }
    } else if (msg.hook === "PostToolUse") {
        const text = formatPostToolUse(msg)
        if (!text) return
        for (const chat_id of access.allowFrom) {
            const active = getActiveToolMessage(msg.sessionId, msg.tool_name)
            if (active && active.chatId === chat_id) {
                // Replace the in-flight PreToolUse stub with the PostToolUse
                // result, in place. replaceLastHookItem handles scrolling if
                // the upgraded item pushes us over COLLAPSE_LIMIT.
                const last = getLastHookMessage(chat_id)
                if (last && last.messageId === active.messageId) {
                    const items = replaceLastHookItem(chat_id, msg.sessionId, text)
                    const combined = items.join("\n")
                    try {
                        await bot.api.editMessageText(chat_id, active.messageId, combined, MD)
                        setLastHookMessage(chat_id, active.messageId, items, msg.sessionId)
                    } catch (e) {
                        dbg("HOOK", "editMessageText failed, falling back to sendOrEdit:", e)
                        await sendOrEdit(chat_id, text)
                    }
                } else {
                    await sendOrEdit(chat_id, text)
                }
                clearActiveToolMessage(msg.sessionId, msg.tool_name)
            }
        }
    }
}

// === Telegram bot handlers ===

function safeName(s) {
    return s?.replace(/[<>\[\]\r\n;]/g, "_")
}

async function handleInbound(ctx, text, downloadImage, attachment) {
    dbg("INBOUND", "text:", text, "from:", ctx.from?.id, "chat:", ctx.chat?.id)
    logMessage({
        direction: "in",
        chat_id: ctx.chat?.id != null ? String(ctx.chat.id) : undefined,
        chat_type: ctx.chat?.type,
        message_id: ctx.message?.message_id,
        user_id: ctx.from?.id != null ? String(ctx.from.id) : undefined,
        user: ctx.from?.username ?? (ctx.from?.id != null ? String(ctx.from.id) : undefined),
        text,
        has_attachment: !!attachment,
    })
    const result = gate(ctx, botUsername, BOOT_ACCESS)
    dbg("INBOUND", "gate result:", result.action)

    if (result.action === "drop") {
        return
    }

    if (result.action === "pair") {
        const lead = result.isResend ? "Still pending" : "Pairing required"
        const userId = String(ctx.from.id)
        await ctx.reply(
            `${lead} — your user ID is ${userId}\n\nRun in Claude Code:\n/telegram:access pair ${result.code}\n\nOr add directly to access.json:\n"allowFrom": ["${userId}"]`
        )
        return
    }

    const access = result.access
    const from = ctx.from
    const chat_id = String(ctx.chat.id)
    const msgId = ctx.message?.message_id

    // Permission-reply intercept
    const permMatch = PERMISSION_REPLY_RE.exec(text)
    if (permMatch) {
        const request_id = permMatch[2].toLowerCase()
        const behavior = permMatch[1].toLowerCase().startsWith("y") ? "allow" : "deny"

        // Route to the session that originated the request
        const perm = pendingPermissions.get(request_id)
        const targetId = perm?.sessionId ?? focusedSessionId
        const target = sessions.get(targetId ?? "")
        if (target) {
            sendIpc(target.conn, { type: "permission_reply", request_id, behavior })
        }
        pendingPermissions.delete(request_id)

        if (msgId != null) {
            const emoji = behavior === "allow" ? "\u2705" : "\u274C"
            void bot.api.setMessageReaction(chat_id, msgId, [
                { type: "emoji", emoji },
            ]).catch(ff)
        }
        return
    }

    // Typing indicator
    void bot.api.sendChatAction(chat_id, "typing").catch(ff)

    // Ack reaction
    if (access.ackReaction && msgId != null) {
        void bot.api
            .setMessageReaction(chat_id, msgId, [
                { type: "emoji", emoji: access.ackReaction },
            ])
            .catch(ff)
    }

    const imagePath = downloadImage ? await downloadImage() : undefined

    const replyTo = ctx.message?.reply_to_message
    const meta = {
        chat_id,
        ...(msgId != null ? { message_id: String(msgId) } : {}),
        user: from.username ?? String(from.id),
        user_id: String(from.id),
        ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
        ...(replyTo ? {
            reply_to_message_id: String(replyTo.message_id),
            ...(replyTo.text ? { reply_to_text: replyTo.text } : {}),
            ...(replyTo.from ? { reply_to_user: replyTo.from.username ?? String(replyTo.from.id) } : {}),
        } : {}),
        ...(imagePath ? { image_path: imagePath } : {}),
        ...(attachment ? {
            attachment_kind: attachment.kind,
            attachment_file_id: attachment.file_id,
            ...(attachment.size != null ? { attachment_size: String(attachment.size) } : {}),
            ...(attachment.mime ? { attachment_mime: attachment.mime } : {}),
            ...(attachment.name ? { attachment_name: attachment.name } : {}),
        } : {}),
    }

    // A new user message ends any hook-message append run — subsequent
    // hook events should land in a fresh message below the user, not edit
    // the bot status that sat above their message.
    clearLastHookMessage(chat_id)

    // If this is a telegram-reply to a bot message, extract the session ID
    let delivered = false
    if (replyTo && replyTo.from?.id === bot.botInfo.id && replyTo.text) {
        const switchMatch = /^\/(?:switch|chat)_([a-z0-9_-]+)/i.exec(replyTo.text)
        if (switchMatch) {
            const targetSession = switchMatch[1]
            dbg("ROUTE", "telegram-reply targets session:", targetSession, "instead of focused:", focusedSessionId)
            delivered = deliverToSession(targetSession, text, meta)
        }
    }
    if (!delivered) {
        delivered = deliverToFocused(text, meta)
    }
    if (!delivered) {
        await bot.api.sendMessage(
            chat_id,
            "No sessions connected. Use /new/new <name> to start a new one."
        ).catch(ff)
    } else {
        const verbs = [
            "Pondering", "Cogitating", "Ruminating", "Deliberating", "Musing",
            "Contemplating", "Noodling", "Percolating", "Brainstorming", "Scheming",
            "Theorizing", "Hypothesizing", "Marinating", "Gestating", "Fermenting",
            "Synthesizing", "Extrapolating", "Interpolating", "Confabulating", "Philosophizing",
            "Introspecting", "Daydreaming", "Woolgathering", "Spit-balling", "Riffing",
            "Ideating", "Cerebrating", "Meditating", "Mulling", "Stewing", "Elucidating",
            "Perambulating", "Galvanizing", "Concocting", "Tinkering", "Whittling",
            "Excavating", "Deciphering", "Untangling", "Spelunking", "Cartographing",
        ]
        const verb = verbs[Math.floor(Math.random() * verbs.length)]
        const tip = getRandomTip()
        const tipText = tip ? `\n\n<i>did you know:</i> ${tip}` : ""
        bot.api.sendMessage(chat_id, `<i>${verb}...</i>${tipText}`, { parse_mode: "HTML" }).catch(ff)
    }
}

// Bot command handlers
bot.command("reload", async (ctx) => {
    if (ctx.chat?.type !== "private") {
        return
    }
    const access = loadAccess(BOOT_ACCESS)
    const senderId = String(ctx.from?.id)
    if (!access.allowFrom.includes(senderId)) {
        return
    }

    const { loaded, errors } = await loadCommands(COMMANDS_DIR, CUSTOM_COMMANDS_DIR)
    publishCommandMenu()
    const parts = [`Reloaded: ${loaded} command(s)`]
    if (errors.length > 0) {
        parts.push(`\nErrors:\n${errors.join("\n")}`)
    }
    await ctx.reply(parts.join(""))
})

// Inline button handler for permissions
bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data

    // Command error debug button
    const errMatch = /^cmderr:fix:([a-f0-9]+)$/.exec(data)
    if (errMatch) {
        const access = loadAccess(BOOT_ACCESS)
        const senderId = String(ctx.from.id)
        if (!access.allowFrom.includes(senderId)) {
            await ctx.answerCallbackQuery({ text: "Not authorized." }).catch(ff)
            return
        }
        const errorId = errMatch[1]
        const errInfo = pendingCommandErrors.get(errorId)
        if (!errInfo) {
            await ctx.answerCallbackQuery({ text: "Error details expired." }).catch(ff)
            return
        }
        pendingCommandErrors.delete(errorId)

        // Immediately acknowledge
        await ctx.answerCallbackQuery({ text: "Fixing! One moment..." }).catch(ff)
        const cbMsg = ctx.callbackQuery.message
        if (cbMsg && "text" in cbMsg && cbMsg.text) {
            await ctx.editMessageText(`${cbMsg.text}\n\n\uD83D\uDD27 Sending to Claude for debugging...`).catch(ff)
        }

        // If no session is connected, spawn one
        if (sessions.size === 0) {
            const spawnHandler = getHotCommands().get("spawn")
            if (spawnHandler) {
                try {
                    await spawnHandler(ctx, bot, getCommandState())
                } catch (e) {
                    dbg("CMDERR", "failed to auto-spawn session:", e)
                }
                // Wait for the session to register
                for (let i = 0; i < 20; i++) {
                    if (sessions.size > 0) {
                        break
                    }
                    await new Promise(r => setTimeout(r, 500))
                }
            }
        }

        let isCustom = false
        try {
            Deno.statSync(join(CUSTOM_COMMANDS_DIR, errInfo.cmdName + ".js"))
            isCustom = true
        } catch (e) {
            dbg("COMMANDS", `${errInfo.cmdName}.js not in custom commands dir:`, e)
        }
        const fileLoc = isCustom
            ? `${CUSTOM_COMMANDS_DIR}/${errInfo.cmdName}.js`
            : "the commands/ directory in the plugin source"
        const debugMsg =
            `The Telegram command /${errInfo.cmdName} threw an error. ` +
            "Please fix it and hot-reload.\n\n" +
            `Error: ${errInfo.error}\n` +
            `Stack: ${errInfo.stack}\n\n` +
            `The command file is at: ${fileLoc}\n` +
            `The user's message was: ${errInfo.text}\n\n` +
            "After fixing, use the reload MCP tool to hot-reload the commands."
        const chat_id = String(ctx.callbackQuery.message?.chat.id ?? ctx.from.id)
        const meta = {
            chat_id,
            user: ctx.from.username ?? String(ctx.from.id),
            user_id: String(ctx.from.id),
        }
        const delivered = deliverToFocused(debugMsg, meta)
        if (!delivered) {
            await bot.api.sendMessage(chat_id, "Could not deliver to a Claude session. Try /new/new first, then click the fix button again.").catch(ff)
        }
        return
    }

    const m = /^perm:(allow|deny|more):([a-km-z]{5})$/.exec(data)
    if (!m) {
        await ctx.answerCallbackQuery().catch(ff)
        return
    }
    const access = loadAccess(BOOT_ACCESS)
    const senderId = String(ctx.from.id)
    if (!access.allowFrom.includes(senderId)) {
        await ctx.answerCallbackQuery({ text: "Not authorized." }).catch(ff)
        return
    }
    const [, behavior, request_id] = m

    if (behavior === "more") {
        const details = pendingPermissions.get(request_id)
        if (!details) {
            await ctx.answerCallbackQuery({ text: "Details no longer available." }).catch(ff)
            return
        }
        const { tool_name, description, input_preview } = details
        let prettyInput
        try {
            prettyInput = JSON.stringify(JSON.parse(input_preview), null, 2)
        } catch (e) {
            dbg("PERM", "failed to pretty-print input_preview:", e)
            prettyInput = input_preview
        }
        const expanded =
            `\uD83D\uDD10 Permission: ${tool_name}\n\n` +
            `tool_name: ${tool_name}\n` +
            `description: ${description}\n` +
            `input_preview:\n${prettyInput}`
        const keyboard = new InlineKeyboard()
            .text("\u2705 Allow", `perm:allow:${request_id}`)
            .text("\u274C Deny", `perm:deny:${request_id}`)
        await ctx.editMessageText(expanded, { reply_markup: keyboard }).catch(ff)
        await ctx.answerCallbackQuery().catch(ff)
        return
    }

    // Route permission reply to the originating session
    const perm = pendingPermissions.get(request_id)
    const targetId = perm?.sessionId ?? focusedSessionId
    const target = sessions.get(targetId ?? "")
    if (target) {
        sendIpc(target.conn, { type: "permission_reply", request_id, behavior })
    }
    pendingPermissions.delete(request_id)
    const label = behavior === "allow" ? "\u2705 Allowed" : "\u274C Denied"
    await ctx.answerCallbackQuery({ text: label }).catch(ff)
    const msg = ctx.callbackQuery.message
    if (msg && "text" in msg && msg.text) {
        await ctx.editMessageText(`${msg.text}\n\n${label}`).catch(ff)
    }
})

// Message handlers
bot.on("message:text", async (ctx) => {
    const text = ctx.message.text
    dbg("EVENT", "message:text received:", text, "from:", ctx.from?.id)

    // /switch_<id> or /chat_<id>
    const switchMatch = /^\/(?:switch|chat)_([a-zA-Z0-9_]+)/i.exec(text)
    if (switchMatch) {
        const access = loadAccess(BOOT_ACCESS)
        const senderId = String(ctx.from?.id)
        if (!access.allowFrom.includes(senderId)) {
            return
        }

        const targetId = switchMatch[1]
        const sessionList = allSessions()
        const target = sessionList.find(s => s.id === targetId)
        if (!target) {
            // The session might still be booting after /new — if a dtach
            // socket exists for that id, queue the focus and apply it on
            // register instead of telling the user it doesn't exist.
            let pending = false
            try {
                Deno.statSync(join(STATE_DIR, `dtach-${targetId}.sock`))
                pending = true
            } catch (e) { dbg("ROUTE", "no dtach socket for", targetId, ":", e) }
            if (pending) {
                pendingFocusId = targetId
                await ctx.reply(`Session ${targetId} is still starting — will switch as soon as it connects.`)
                return
            }
            await ctx.reply(`Session "${targetId}" not found. Use /list to see available sessions.`)
            return
        }
        focusedSessionId = targetId
        const parts = [`Switched to session ${targetId}`]
        if (target.title) {
            parts[0] += `: ${target.title}`
        }
        await ctx.reply(parts.join("\n"))
        return
    }

    // /task_status_<id>
    const taskStatusMatch = /^\/task_status_(\w+)/i.exec(text)
    if (taskStatusMatch) {
        const access = loadAccess(BOOT_ACCESS)
        if (!access.allowFrom.includes(String(ctx.from?.id))) { return }
        const taskId = taskStatusMatch[1]
        const task = readTask(taskId)
        if (!task) { await ctx.reply(`Task ${taskId} not found.`); return }
        const dir = taskPath(taskId)
        let progressTail = ""
        try { progressTail = Deno.readTextFileSync(join(dir, "progress.md")).split("\n").slice(-5).join("\n") } catch (e) { dbg("TASK", "no progress.md:", e) }
        const tEsc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        const age = Math.round((Date.now() - new Date(task.createdAt).getTime()) / 60000)
        const lines = [
            `<b>Task: ${tEsc(task.id)}</b>`,
            `State: ${task.state}`,
            `Session: ${tEsc(task.worker.sessionId)}`,
            `Created: ${age} min ago`,
            `Critic calls: ${task.critic.callCount}`,
            `Nudges: ${task.nudge.totalNudges}`,
        ]
        if (progressTail) {
            lines.push(``, `<b>Progress (last 5 lines):</b>`, `<pre>${tEsc(progressTail)}</pre>`)
        }
        lines.push(``, `/task_view_${taskId}`, `/task_update_${taskId}`, `/task_cancel_${taskId}`)
        await ctx.reply(lines.join("\n"), { parse_mode: "HTML" })
        return
    }

    // /task_view_<id> — send definition as .md file attachment
    const taskViewMatch = /^\/task_view_(\w+)/i.exec(text)
    if (taskViewMatch) {
        const access = loadAccess(BOOT_ACCESS)
        if (!access.allowFrom.includes(String(ctx.from?.id))) { return }
        const taskId = taskViewMatch[1]
        const def = getDefinition(taskId)
        if (!def) { await ctx.reply("No definition found for that task."); return }
        const tmpPath = join(STATE_DIR, `${taskId}-definition.md`)
        Deno.writeTextFileSync(tmpPath, def)
        try {
            const { InputFile: TgInputFile } = await import("./imports.js")
            await ctx.replyWithDocument(new TgInputFile(tmpPath, `${taskId}-definition-of-done.md`))
        } catch (e) {
            dbg("TASK", "sendDocument failed:", e)
            await ctx.reply(`<pre>${def.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").slice(0, 3000)}</pre>`, { parse_mode: "HTML" })
        }
        try { Deno.removeSync(tmpPath) } catch (e) { dbg("TASK", "tmp cleanup:", e) }
        return
    }

    // /task_update_<id> [new definition]
    const taskUpdateMatch = /^\/task_update_(\w+)(?:\s+([\s\S]+))?/i.exec(text)
    if (taskUpdateMatch) {
        const access = loadAccess(BOOT_ACCESS)
        if (!access.allowFrom.includes(String(ctx.from?.id))) { return }
        const taskId = taskUpdateMatch[1]
        const newDef = taskUpdateMatch[2]?.trim()
        const task = readTask(taskId)
        if (!task) { await ctx.reply(`Task ${taskId} not found.`); return }
        if (!newDef) {
            const current = getDefinition(taskId)
            const tEsc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            await ctx.reply(current
                ? `Current definition:\n<pre>${tEsc(current.slice(0, 3000))}</pre>\n\nReply with /task_update_${taskId} &lt;new definition&gt; to replace it.`
                : `No definition yet. Reply with /task_update_${taskId} &lt;definition&gt; to set it.`,
                { parse_mode: "HTML" })
            return
        }
        storeDefinition(taskId, newDef)
        appendLog(taskId, "critic.log", { event: "definition_updated_by_user" })
        const session = sessions.get(task.worker.sessionId)
        if (session?.info.dtachSocket) {
            try {
                const proc = new Deno.Command("dtach", {
                    args: ["-p", session.info.dtachSocket],
                    stdin: "piped", stdout: "null", stderr: "null",
                }).spawn()
                const w = proc.stdin.getWriter()
                await w.write(new TextEncoder().encode(`[long task ${taskId}] The user has updated the definition of done. Review your progress and adjust.\n`))
                await w.close()
                await proc.status
            } catch (e) { dbg("TASK", "update inject failed:", e) }
        }
        await ctx.reply("Definition updated.")
        return
    }

    // /task_cancel_<id>
    const taskCancelMatch = /^\/task_cancel_(\w+)/i.exec(text)
    if (taskCancelMatch) {
        const access = loadAccess(BOOT_ACCESS)
        if (!access.allowFrom.includes(String(ctx.from?.id))) { return }
        const taskId = taskCancelMatch[1]
        const task = cancelTask(taskId)
        if (!task) { await ctx.reply(`Task ${taskId} not found.`); return }
        const session = sessions.get(task.worker.sessionId)
        if (session?.info.dtachSocket) {
            try {
                const proc = new Deno.Command("dtach", {
                    args: ["-p", session.info.dtachSocket],
                    stdin: "piped", stdout: "null", stderr: "null",
                }).spawn()
                const w = proc.stdin.getWriter()
                await w.write(new TextEncoder().encode(`[long task ${taskId} — cancelled] The user has cancelled this task. Stop working on it.\n`))
                await w.close()
                await proc.status
            } catch (e) { dbg("TASK", "cancel inject failed:", e) }
        }
        await ctx.reply(`Task ${taskId} cancelled.`)
        return
    }

    // __onMessage hook (only for approved users)
    const onMsgAccess = loadAccess(BOOT_ACCESS)
    const onMsgSenderId = String(ctx.from?.id)
    if (onMsgAccess.allowFrom.includes(onMsgSenderId)) {
        const onMsg = getHotCommands().get("__onMessage")
        if (onMsg) {
            try { await onMsg(ctx, bot, getCommandState()) } catch (e) { dbg("COMMANDS", "__onMessage failed:", e) }
        }
    }

    // Hot-reloadable commands
    const cmdMatch = /^\/(\w+)/.exec(text)
    if (cmdMatch) {
        const cmdName = cmdMatch[1].toLowerCase()

        // Block all commands except approve_user for unapproved users
        if (cmdName !== "approve_user") {
            const access = loadAccess(BOOT_ACCESS)
            const senderId = String(ctx.from?.id)
            if (!access.allowFrom.includes(senderId)) {
                await ctx.reply("You need to be approved first. Ask the bot owner for an /approve_user command.")
                return
            }
        }

        const handler = getHotCommands().get(cmdName)
        if (handler) {
            try {
                const handled = await handler(ctx, bot, getCommandState())
                if (handled) {
                    return
                }
            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err)
                const errStack = err instanceof Error ? err.stack ?? "" : ""
                dbg("HOT", `command ${cmdName} error:`, err)
                const errorId = randomHex(3)
                pendingCommandErrors.set(errorId, { cmdName, error: errMsg, stack: errStack, text, createdAt: Date.now() })
                const keyboard = new InlineKeyboard()
                    .text("\uD83D\uDD27 Ask Claude to fix", `cmderr:fix:${errorId}`)
                await ctx.reply(`\u26A0\uFE0F /${cmdName} failed: ${errMsg}`, { reply_markup: keyboard }).catch(ff)
            }
        }
    }

    await handleInbound(ctx, text, undefined)
})

bot.on("message:photo", async (ctx) => {
    const caption = ctx.message.caption ?? "(photo)"
    await handleInbound(ctx, caption, async () => {
        const photos = ctx.message.photo
        const best = photos[photos.length - 1]
        try {
            const file = await ctx.api.getFile(best.file_id)
            if (!file.file_path) {
                return undefined
            }
            const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`
            const res = await fetch(url)
            const buf = new Uint8Array(await res.arrayBuffer())
            const ext = file.file_path.split(".").pop() ?? "jpg"
            const path = join(INBOX_DIR, `${Date.now()}-${best.file_unique_id}.${ext}`)
            Deno.mkdirSync(INBOX_DIR, { recursive: true })
            Deno.writeFileSync(path, buf)
            return path
        } catch (err) {
            Deno.stderr.writeSync(new TextEncoder().encode(`telegram server: photo download failed: ${err}\n`))
            return undefined
        }
    })
})

bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document
    const name = safeName(doc.file_name)
    const text = ctx.message.caption ?? `(document: ${name ?? "file"})`
    await handleInbound(ctx, text, undefined, {
        kind: "document", file_id: doc.file_id, size: doc.file_size, mime: doc.mime_type, name,
    })
})

bot.on("message:voice", async (ctx) => {
    const voice = ctx.message.voice
    const text = ctx.message.caption ?? "(voice message)"
    await handleInbound(ctx, text, undefined, {
        kind: "voice", file_id: voice.file_id, size: voice.file_size, mime: voice.mime_type,
    })
})

bot.on("message:audio", async (ctx) => {
    const audio = ctx.message.audio
    const name = safeName(audio.file_name)
    const text = ctx.message.caption ?? `(audio: ${safeName(audio.title) ?? name ?? "audio"})`
    await handleInbound(ctx, text, undefined, {
        kind: "audio", file_id: audio.file_id, size: audio.file_size, mime: audio.mime_type, name,
    })
})

bot.on("message:video", async (ctx) => {
    const video = ctx.message.video
    const text = ctx.message.caption ?? "(video)"
    await handleInbound(ctx, text, undefined, {
        kind: "video", file_id: video.file_id, size: video.file_size, mime: video.mime_type, name: safeName(video.file_name),
    })
})

bot.on("message:video_note", async (ctx) => {
    const vn = ctx.message.video_note
    await handleInbound(ctx, "(video note)", undefined, {
        kind: "video_note", file_id: vn.file_id, size: vn.file_size,
    })
})

bot.on("message:sticker", async (ctx) => {
    const sticker = ctx.message.sticker
    const emoji = sticker.emoji ? ` ${sticker.emoji}` : ""
    await handleInbound(ctx, `(sticker${emoji})`, undefined, {
        kind: "sticker", file_id: sticker.file_id, size: sticker.file_size,
    })
})

bot.catch((err) => {
    dbg("ERROR", "handler error:", err.error)
    Deno.stderr.writeSync(new TextEncoder().encode(
        `telegram server: handler error (polling continues): ${err.error}\n`
    ))
})

// === IPC Accept Loop ===

async function handleConnection(conn) {
    const decoder = new TextDecoder()
    const buf = new Uint8Array(8192)
    let remainder = ""
    let sessionId = null

    try {
        while (true) {
            const n = await conn.read(buf)
            if (n === null) {
                break
            }
            const result = parseIpcMessages(remainder, decoder.decode(buf.subarray(0, n)))
            remainder = result.remaining
            for (const msg of result.messages) {
                handleShimMessage(conn, msg)
                if (msg.type === "register") {
                    sessionId = msg.session.id
                }
            }
        }
    } catch (e) {
        dbg("IPC", "connection error:", e)
    }

    if (sessionId) {
        dbg("IPC", "session disconnected:", sessionId)
        sessions.delete(sessionId)
        trackerDropSession(sessionId)
        if (focusedSessionId === sessionId) {
            focusedSessionId = sessions.size > 0 ? sessions.keys().next().value : null
            dbg("IPC", "focus moved to:", focusedSessionId ?? "none")
        }
    }
}

// === Startup ===

if (!STATIC) {
    setInterval(() => checkApprovals(bot), 5000)
}

try { Deno.removeSync(IPC_SOCK) } catch (e) { dbg("IPC", "failed to remove old socket:", e) }

let listener = Deno.listen({ transport: "unix", path: IPC_SOCK })
dbg("IPC", "listening on", IPC_SOCK)

;(async () => {
    while (true) {
        try {
            const conn = await listener.accept()
            handleConnection(conn)
        } catch (err) {
            if (err instanceof Deno.errors.BadResource) {
                break // listener closed (shutdown)
            }
            dbg("IPC", "accept error (continuing):", err instanceof Error ? err.message : String(err))
        }
    }
})()

void (async () => {
    for (let attempt = 1; ; attempt++) {
        try {
            dbg("POLL", "calling bot.start(), attempt:", attempt)
            await bot.start({
                onStart: (info) => {
                    botUsername = info.username
                    dbg("POLL", "bot started, polling as @" + info.username)
                    Deno.stderr.writeSync(new TextEncoder().encode(
                        `telegram server: polling as @${info.username} (standalone)\n`
                    ))
                    publishCommandMenu()
                },
            })
            return
        } catch (err) {
            if (err instanceof GrammyError && err.error_code === 409) {
                const delay = Math.min(1000 * attempt, 15000)
                Deno.stderr.writeSync(new TextEncoder().encode(
                    `telegram server: 409 Conflict, retrying in ${delay / 1000}s\n`
                ))
                await new Promise(r => setTimeout(r, delay))
                continue
            }
            if (err instanceof Error && err.message === "Aborted delay") {
                return
            }
            // Retry transient network errors with backoff (up to 5 attempts)
            const isNetworkError = err instanceof TypeError || (err instanceof Error && /fetch|network|ECONNREFUSED|ETIMEDOUT/i.test(err.message))
            if (isNetworkError && attempt < 5) {
                const delay = Math.min(2000 * attempt, 15000)
                Deno.stderr.writeSync(new TextEncoder().encode(
                    `telegram server: network error, retrying in ${delay / 1000}s (attempt ${attempt})\n`
                ))
                await new Promise(r => setTimeout(r, delay))
                continue
            }
            Deno.stderr.writeSync(new TextEncoder().encode(`telegram server: polling failed: ${err}\n`))
            return
        }
    }
})()

function shutdown() {
    Deno.stderr.writeSync(new TextEncoder().encode("telegram server: shutting down\n"))
    for (const [, s] of sessions) {
        try { s.conn.close() } catch (e) { dbg("IPC", "failed to close session conn:", e) }
    }
    sessions.clear()
    listener.close()
    try { Deno.removeSync(IPC_SOCK) } catch (e) { dbg("SHUTDOWN", "failed to remove socket:", e) }
    try { Deno.removeSync(PID_FILE) } catch (e) { dbg("SHUTDOWN", "failed to remove pid file:", e) }
    setTimeout(() => Deno.exit(0), 2000)
    void Promise.resolve(bot.stop()).finally(() => Deno.exit(0))
}
Deno.addSignalListener("SIGTERM", shutdown)
Deno.addSignalListener("SIGINT", shutdown)

// === Unified idle detection ===
//
// One scanner, one signal bus. Handlers decide what to act on.
//
// Signal sources:
//   1. Stop hooks → idleDetector.onSessionStop(id)  (immediate, precise)
//   2. Time-based scanner → idleDetector.onSessionIdle(id)  (fallback)
//
// The scanner only runs the log-size check for sessions without a recent
// Stop hook. Stop hooks are authoritative when available.
//
// Handlers (registered below):
//   - long-task: owns the session when there's an active task
//   - telegram-reply: only fires when there is NO active long task
//     (long-task handler takes priority for its sessions)

const NUDGE_WAIT_MS = 45_000
const NUDGE_IDLE_MS = 5_000
const NUDGE_SCAN_MS = 5_000
const STOP_RECENT_MS = 10 * 60 * 1000  // Stop hook considered "recent" for this long
const NUDGE_TEXT = "[automated reminder] You received a Telegram message but haven't replied yet. Please call the telegram reply tool now to respond to the user."

function logSize(dtachSocket) {
    try {
        const logPath = dtachSocket.replace(/\.sock$/, ".log")
        return Deno.statSync(logPath).size
    } catch {
        return null
    }
}

async function injectDtach(dtachSocket, text, label) {
    try {
        const proc = new Deno.Command("dtach", {
            args: ["-p", dtachSocket],
            stdin: "piped",
            stdout: "null",
            stderr: "null",
        }).spawn()
        const w = proc.stdin.getWriter()
        await w.write(new TextEncoder().encode(text + "\n"))
        await w.close()
        await proc.status
        return true
    } catch (e) {
        dbg(label ?? "DTACH", `inject failed: ${e}`)
        return false
    }
}

// === Long task subsystem init ===
rebuildIndex()
restoreDefinitionsFromDisk()
const longTaskHttpPort = startHttpServer()
if (longTaskHttpPort) {
    dbg("TASK", `long-task HTTP on port ${longTaskHttpPort}`)
}

const idleDetector = createIdleDetector()

// Handler 1: long-task owns its session's idle signals.
// When a task is active for this session, only this handler runs (the
// telegram-reply handler bails early on the same check).
idleDetector.addHandler("long-task", async (sessionId, source) => {
    const task = findActiveTaskForSession(sessionId)
    if (!task) { return }
    if (task.state !== "in_progress" && task.state !== "awaiting_report") { return }

    const session = sessions.get(sessionId)
    if (!session?.info.dtachSocket) { return }

    const nudge = { ...task.nudge }
    nudge.consecutiveIdleStops = (nudge.consecutiveIdleStops || 0) + 1
    nudge.lastStopAt = new Date().toISOString()

    const threshold = 2
    if (nudge.consecutiveIdleStops < threshold) {
        updateTask(task.id, { nudge })
        return
    }

    const dir = taskPath(task.id)
    const hasReport = (() => { try { Deno.statSync(join(dir, "report.md")); return true } catch { return false } })()

    if (hasReport && task.state !== "awaiting_verdict") {
        nudge.consecutiveIdleStops = 0
        updateTask(task.id, { state: "awaiting_verdict", nudge })
        void runCriticFlow(task.id, session.info.dtachSocket, task.createdBy.chatId)
        return
    }

    if (!hasReport) {
        const nudgeText = `[long task ${task.id}]\nIf you are done, please write $HOME/.cbg/long-tasks/${task.id}/report.md summarizing what you accomplished and why each requirement is met. Include the PWD, branch, files changed, and concrete evidence — the reviewer has no other context.\nIf you are not done, please continue working, logging progress to $HOME/.cbg/long-tasks/${task.id}/progress.md, and write report.md when done.`
        await injectDtach(session.info.dtachSocket, nudgeText, "TASK")

        nudge.totalNudges = (nudge.totalNudges || 0) + 1
        nudge.lastNudgeAt = new Date().toISOString()
        nudge.consecutiveIdleStops = 0
        updateTask(task.id, { state: "awaiting_report", nudge })
        appendLog(task.id, "worker.log", { event: "nudge", source })
    }
})

// Handler 2: telegram-reply reminder. Only fires for sessions WITHOUT
// an active long task — long-task owns those sessions exclusively.
idleDetector.addHandler("telegram-reply", async (sessionId, _source) => {
    // Long-task handler has priority: if there's an active task, bail.
    if (findActiveTaskForSession(sessionId)) { return }

    const entry = trackerGetEntry(sessionId)
    if (!entry || entry.nudged) { return }
    if (!trackerIsPending(sessionId)) { return }
    if (!entry.lastInbound) { return }
    const age = Date.now() - entry.lastInbound.ts
    if (age < NUDGE_WAIT_MS) { return }

    const session = sessions.get(sessionId)
    if (!session?.info.dtachSocket) {
        dbg("NUDGE", `session ${sessionId} has no dtach socket — skipping`)
        return
    }

    dbg("NUDGE", `nudging session ${sessionId} — pending message, no reply`)
    const ok = await injectDtach(session.info.dtachSocket, NUDGE_TEXT, "NUDGE")
    if (ok) {
        trackerMarkNudged(sessionId)
    }
})

async function runCriticFlow(taskId, dtachSocket, chatId) {
    const maxRetries = 3
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const task = readTask(taskId)
        if (!task || task.state === "cancelled") { return }

        const result = await runCritic(taskId)
        const taskAfter = readTask(taskId)
        if (taskAfter) {
            const critic = { ...taskAfter.critic }
            critic.callCount = (critic.callCount || 0) + 1
            critic.lastCallAt = new Date().toISOString()
            updateTask(taskId, { critic })
        }

        if (result.verdict === "indecisive" || result.verdict === "error") {
            if (attempt < maxRetries - 1) {
                dbg("TASK", `critic indecisive for ${taskId}, retry ${attempt + 1}`)
                continue
            }
            const access = loadAccess(BOOT_ACCESS)
            for (const cid of access.allowFrom) {
                try {
                    await bot.api.sendMessage(cid, `Task ${taskId}: critic failed after ${maxRetries} attempts. Please intervene.\n/task_status_${taskId}`)
                } catch (e) { dbg("TASK", "escalation msg failed:", e) }
            }
            updateTask(taskId, { state: "in_progress" })
            return
        }

        const { state: _state, injectText, telegramText } = processVerdict(taskId, result.verdict)

        if (injectText && dtachSocket) {
            await injectDtach(dtachSocket, injectText, "TASK")
        }

        if (telegramText) {
            const access = loadAccess(BOOT_ACCESS)
            for (const cid of access.allowFrom) {
                try { await bot.api.sendMessage(cid, telegramText) } catch (e) { dbg("TASK", "telegram msg failed:", e) }
            }
        }

        return
    }
}

// === Unified scanner ===
//
// Single setInterval that drives idle detection. For each session with a
// dtach socket:
//   1. If a Stop hook fired recently → skip (Stop is authoritative).
//   2. Otherwise, read log size, wait NUDGE_IDLE_MS, read again.
//   3. If unchanged → fire onSessionIdle(sessionId).
//
// The handlers (long-task, telegram-reply) decide whether to act.
setInterval(() => {
    const now = Date.now()
    for (const [sid, session] of sessions) {
        if (!session.info.dtachSocket) { continue }
        const lastStop = idleDetector.getLastStopAt(sid)
        if (lastStop && (now - lastStop) < STOP_RECENT_MS) { continue }

        const before = logSize(session.info.dtachSocket)
        if (before == null) { continue }

        void (async () => {
            await new Promise(r => setTimeout(r, NUDGE_IDLE_MS))
            const after = logSize(session.info.dtachSocket)
            if (after === before) {
                idleDetector.onSessionIdle(sid)
            }
        })()
    }
}, NUDGE_SCAN_MS)

dbg("SERVER", "standalone server ready")
