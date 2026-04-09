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

import { Bot, GrammyError, InlineKeyboard, join, fromFileUrl } from "./imports.js"
import {
    STATE_DIR, IPC_SOCK, PID_FILE, INBOX_DIR,
    sendIpc, parseIpcMessages, dbg,
} from "./lib/protocol.js"
import {
    loadAccess, readAccessFile, saveAccess, gate, checkApprovals,
    assertAllowedChat,
} from "./lib/access.js"
import { loadCommands, getHotCommands } from "./lib/commands.js"
import { createToolExecutor } from "./lib/telegram-api.js"
import {
    formatPreToolUse, formatPostToolUse,
    setActiveToolMessage, getActiveToolMessage, clearActiveToolMessage,
} from "./lib/hooks.js"
import { getBotToken } from "./lib/config.js"
import { generateName } from "./lib/names.js"

const HOME = Deno.env.get("HOME")

function randomHex(bytes) {
    const arr = new Uint8Array(bytes)
    crypto.getRandomValues(arr)
    return Array.from(arr, b => b.toString(16).padStart(2, "0")).join("")
}

function execSync(cmd) {
    const result = new Deno.Command("sh", {
        args: ["-c", cmd],
        stdout: "piped",
        stderr: "piped",
    }).outputSync()
    return new TextDecoder().decode(result.stdout).trim()
}

const PLUGIN_VERSION = (() => {
    try {
        const dir = import.meta.dirname ?? fromFileUrl(new URL(".", import.meta.url))
        return JSON.parse(Deno.readTextFileSync(join(dir, ".claude-plugin", "plugin.json"))).version
    } catch {
        return "unknown"
    }
})()

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
} catch {
    // no pid file or not running — we proceed
}

// === PID file ===
Deno.writeTextFileSync(PID_FILE, String(Deno.pid))

// === Session registry ===
const sessions = new Map()
let focusedSessionId = null

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
const pendingPermissions = new Map()
const pendingCommandErrors = new Map()

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
            try { await onReply({ text, chat_id }, bot, getCommandState()) } catch { /* ignore */ }
        }
    },
)

// === Commands ===
const COMMANDS_DIR = join(import.meta.dirname ?? fromFileUrl(new URL(".", import.meta.url)), "commands")
const CUSTOM_COMMANDS_DIR = join(HOME, ".claude", "telegram", "custom_commands")

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
        PLUGIN_VERSION,
    }
}

loadCommands(COMMANDS_DIR, CUSTOM_COMMANDS_DIR).catch(() => {})

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
    return true
}

function deliverToFocused(content, meta) {
    if (!focusedSessionId) {
        messageQueue.push({ content, meta })
        if (messageQueue.length > MAX_QUEUE_SIZE) {
            messageQueue.shift()
        }
        dbg("QUEUE", "queued message, queue size:", messageQueue.length)
        return false
    }
    const session = sessions.get(focusedSessionId)
    if (!session) {
        focusedSessionId = sessions.size > 0 ? sessions.keys().next().value : null
        if (!focusedSessionId) {
            messageQueue.push({ content, meta })
            if (messageQueue.length > MAX_QUEUE_SIZE) {
                messageQueue.shift()
            }
            return false
        }
        return deliverToFocused(content, meta)
    }
    session.info.lastActive = Date.now()
    pushRecentMessage(session, "human", content)
    sendIpc(session.conn, { type: "channel_event", content, meta })
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

            if (!focusedSessionId) {
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
            pendingPermissions.set(request_id, { tool_name, description, input_preview })
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
            const target = sessions.get(focusedSessionId ?? "")
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
                    const parts = [`Wrote ${join(CUSTOM_COMMANDS_DIR, filename)}\nReloaded: ${loaded} command(s)`]
                    if (errors.length > 0) {
                        parts.push(`\nErrors:\n${errors.join("\n")}`)
                    }
                    sendIpc(conn, { type: "tool_response", requestId, result: { content: [{ type: "text", text: parts.join("") }] } })
                    return
                }

                if (name === "enable_telegram_by_default") {
                    const enabled = args.enabled
                    const result = handleEnableTelegramByDefault(enabled)
                    sendIpc(conn, { type: "tool_response", requestId, result })
                    return
                }

                const result = await toolExecutor(name, args)

                // Track last reply text per session (strip the /chat_ header)
                if (name === "reply" && !result.isError && sessionId) {
                    const session = sessions.get(sessionId)
                    if (session) {
                        const raw = args.text ?? ""
                        const stripped = raw.replace(/^\/chat_[a-zA-Z0-9_]+\n/, "")
                        pushRecentMessage(session, "bot", stripped)
                    }
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

async function handleHookEvent(msg) {
    const access = loadAccess(BOOT_ACCESS)
    const sessionTitle = getSessionTitle(msg.sessionId)

    if (msg.hook === "PreToolUse") {
        const text = formatPreToolUse(msg, sessionTitle)
        for (const chat_id of access.allowFrom) {
            try {
                const sent = await bot.api.sendMessage(chat_id, text)
                setActiveToolMessage(msg.sessionId, msg.tool_name, chat_id, sent.message_id)
            } catch (e) {
                dbg("HOOK", "failed to send PreToolUse:", e)
            }
        }
    } else if (msg.hook === "PostToolUse") {
        const text = formatPostToolUse(msg, sessionTitle)
        for (const chat_id of access.allowFrom) {
            const active = getActiveToolMessage(msg.sessionId, msg.tool_name)
            if (active && active.chatId === chat_id) {
                try {
                    await bot.api.editMessageText(chat_id, active.messageId, text)
                    clearActiveToolMessage(msg.sessionId, msg.tool_name)
                } catch {
                    await bot.api.sendMessage(chat_id, text).catch(() => {})
                }
            }
        }
    }
}

// === enable_telegram_by_default ===

function handleEnableTelegramByDefault(enabled) {
    const CHANNELS_FLAG = "--channels plugin:telegram@claude-plugins-official"
    const wrapperDir = join(HOME, ".claude", "bin")
    const wrapperPath = join(wrapperDir, "claude")
    const rcFiles = [join(HOME, ".zshrc"), join(HOME, ".bashrc"), join(HOME, ".bash_profile")]
    const pathLine = 'export PATH="$HOME/.claude/bin:$PATH" # claude-telegram-wrapper'

    if (enabled) {
        let realClaude
        try {
            const cleanPath = (Deno.env.get("PATH") ?? "").split(":").filter(p => !p.includes(".claude/bin")).join(":")
            const result = new Deno.Command("sh", {
                args: ["-c", "which claude"],
                env: { ...Deno.env.toObject(), PATH: cleanPath },
                stdout: "piped",
                stderr: "piped",
            }).outputSync()
            realClaude = new TextDecoder().decode(result.stdout).trim()
            if (!realClaude) {
                throw new Error("not found")
            }
        } catch {
            return { content: [{ type: "text", text: "Error: could not find the claude binary" }] }
        }

        Deno.mkdirSync(wrapperDir, { recursive: true })
        const wrapper = `#!/usr/bin/env bash\n# Auto-generated by claude-telegram-but-good\nexec "${realClaude}" ${CHANNELS_FLAG} "$@"\n`
        Deno.writeTextFileSync(wrapperPath, wrapper)
        Deno.chmodSync(wrapperPath, 0o755)

        for (const rc of rcFiles) {
            try {
                const content = Deno.readTextFileSync(rc)
                if (!content.includes("claude-telegram-wrapper")) {
                    Deno.writeTextFileSync(rc, content + `\n${pathLine}\n`)
                }
            } catch {
                // ignore missing rc files
            }
        }

        return { content: [{ type: "text", text: `Enabled. Wrapper at ${wrapperPath} -> ${realClaude} ${CHANNELS_FLAG}` }] }
    } else {
        try { Deno.removeSync(wrapperPath) } catch { /* ignore */ }
        for (const rc of rcFiles) {
            try {
                const content = Deno.readTextFileSync(rc)
                if (content.includes("claude-telegram-wrapper")) {
                    const cleaned = content.split("\n").filter(l => !l.includes("claude-telegram-wrapper")).join("\n")
                    Deno.writeTextFileSync(rc, cleaned)
                }
            } catch {
                // ignore
            }
        }
        return { content: [{ type: "text", text: "Disabled. Wrapper removed." }] }
    }
}

// === Telegram bot handlers ===

function safeName(s) {
    return s?.replace(/[<>\[\]\r\n;]/g, "_")
}

async function handleInbound(ctx, text, downloadImage, attachment) {
    dbg("INBOUND", "text:", text, "from:", ctx.from?.id, "chat:", ctx.chat?.id)
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

        const target = sessions.get(focusedSessionId ?? "")
        if (target) {
            sendIpc(target.conn, { type: "permission_reply", request_id, behavior })
        }

        if (msgId != null) {
            const emoji = behavior === "allow" ? "\u2705" : "\u274C"
            void bot.api.setMessageReaction(chat_id, msgId, [
                { type: "emoji", emoji },
            ]).catch(() => {})
        }
        return
    }

    // Typing indicator
    void bot.api.sendChatAction(chat_id, "typing").catch(() => {})

    // Ack reaction
    if (access.ackReaction && msgId != null) {
        void bot.api
            .setMessageReaction(chat_id, msgId, [
                { type: "emoji", emoji: access.ackReaction },
            ])
            .catch(() => {})
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
            "No sessions connected. Use /spawn <name> to start a new one."
        ).catch(() => {})
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
            await ctx.answerCallbackQuery({ text: "Not authorized." }).catch(() => {})
            return
        }
        const errorId = errMatch[1]
        const errInfo = pendingCommandErrors.get(errorId)
        if (!errInfo) {
            await ctx.answerCallbackQuery({ text: "Error details expired." }).catch(() => {})
            return
        }
        pendingCommandErrors.delete(errorId)

        // Immediately acknowledge
        await ctx.answerCallbackQuery({ text: "Fixing! One moment..." }).catch(() => {})
        const cbMsg = ctx.callbackQuery.message
        if (cbMsg && "text" in cbMsg && cbMsg.text) {
            await ctx.editMessageText(`${cbMsg.text}\n\n\uD83D\uDD27 Sending to Claude for debugging...`).catch(() => {})
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
            Deno.statSync(join(HOME, ".claude", "telegram", "custom_commands", errInfo.cmdName + ".js"))
            isCustom = true
        } catch {
            // not custom
        }
        const fileLoc = isCustom
            ? `~/.claude/telegram/custom_commands/${errInfo.cmdName}.js`
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
            await bot.api.sendMessage(chat_id, "Could not deliver to a Claude session. Try /spawn first, then click the fix button again.").catch(() => {})
        }
        return
    }

    const m = /^perm:(allow|deny|more):([a-km-z]{5})$/.exec(data)
    if (!m) {
        await ctx.answerCallbackQuery().catch(() => {})
        return
    }
    const access = loadAccess(BOOT_ACCESS)
    const senderId = String(ctx.from.id)
    if (!access.allowFrom.includes(senderId)) {
        await ctx.answerCallbackQuery({ text: "Not authorized." }).catch(() => {})
        return
    }
    const [, behavior, request_id] = m

    if (behavior === "more") {
        const details = pendingPermissions.get(request_id)
        if (!details) {
            await ctx.answerCallbackQuery({ text: "Details no longer available." }).catch(() => {})
            return
        }
        const { tool_name, description, input_preview } = details
        let prettyInput
        try {
            prettyInput = JSON.stringify(JSON.parse(input_preview), null, 2)
        } catch {
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
        await ctx.editMessageText(expanded, { reply_markup: keyboard }).catch(() => {})
        await ctx.answerCallbackQuery().catch(() => {})
        return
    }

    // Route permission reply to focused session
    const target = sessions.get(focusedSessionId ?? "")
    if (target) {
        sendIpc(target.conn, { type: "permission_reply", request_id, behavior })
    }
    pendingPermissions.delete(request_id)
    const label = behavior === "allow" ? "\u2705 Allowed" : "\u274C Denied"
    await ctx.answerCallbackQuery({ text: label }).catch(() => {})
    const msg = ctx.callbackQuery.message
    if (msg && "text" in msg && msg.text) {
        await ctx.editMessageText(`${msg.text}\n\n${label}`).catch(() => {})
    }
})

// Message handlers
bot.on("message:text", async (ctx) => {
    const text = ctx.message.text
    dbg("EVENT", "message:text received:", text, "from:", ctx.from?.id)

    // /switch_<id> or /chat_<id>
    const switchMatch = /^\/(?:switch|chat)_([a-zA-Z0-9_]+)$/i.exec(text)
    if (switchMatch) {
        const access = loadAccess(BOOT_ACCESS)
        const senderId = String(ctx.from?.id)
        if (!access.allowFrom.includes(senderId)) {
            return
        }

        const targetId = switchMatch[1].toLowerCase()
        const sessionList = allSessions()
        const target = sessionList.find(s => s.id === targetId)
        if (!target) {
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

    // __onMessage hook (only for approved users)
    const onMsgAccess = loadAccess(BOOT_ACCESS)
    const onMsgSenderId = String(ctx.from?.id)
    if (onMsgAccess.allowFrom.includes(onMsgSenderId)) {
        const onMsg = getHotCommands().get("__onMessage")
        if (onMsg) {
            try { await onMsg(ctx, bot, getCommandState()) } catch { /* ignore */ }
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
                pendingCommandErrors.set(errorId, { cmdName, error: errMsg, stack: errStack, text })
                const keyboard = new InlineKeyboard()
                    .text("\uD83D\uDD27 Ask Claude to fix", `cmderr:fix:${errorId}`)
                await ctx.reply(`\u26A0\uFE0F /${cmdName} failed: ${errMsg}`, { reply_markup: keyboard }).catch(() => {})
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
    } catch {
        // connection error
    }

    if (sessionId) {
        dbg("IPC", "session disconnected:", sessionId)
        sessions.delete(sessionId)
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

try { Deno.removeSync(IPC_SOCK) } catch { /* ignore */ }

const listener = Deno.listen({ transport: "unix", path: IPC_SOCK })
dbg("IPC", "listening on", IPC_SOCK)

;(async () => {
    for await (const conn of listener) {
        handleConnection(conn)
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
                    bot.api.setMyCommands(
                        [
                            { command: "start", description: "Welcome and setup guide" },
                            { command: "help", description: "What this bot can do" },
                            { command: "status", description: "Check your pairing status" },
                            { command: "list", description: "Show connected sessions" },
                            { command: "spawn", description: "Launch a new Claude Code session" },
                            { command: "reload", description: "Hot-reload command handlers" },
                        ],
                        { scope: { type: "all_private_chats" } },
                    ).catch((e) => dbg("COMMANDS", "setMyCommands failed:", e))
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
            Deno.stderr.writeSync(new TextEncoder().encode(`telegram server: polling failed: ${err}\n`))
            return
        }
    }
})()

function shutdown() {
    Deno.stderr.writeSync(new TextEncoder().encode("telegram server: shutting down\n"))
    for (const [, s] of sessions) {
        try { s.conn.close() } catch { /* ignore */ }
    }
    sessions.clear()
    listener.close()
    try { Deno.removeSync(IPC_SOCK) } catch { /* ignore */ }
    try { Deno.removeSync(PID_FILE) } catch { /* ignore */ }
    setTimeout(() => Deno.exit(0), 2000)
    void Promise.resolve(bot.stop()).finally(() => Deno.exit(0))
}
Deno.addSignalListener("SIGTERM", shutdown)
Deno.addSignalListener("SIGINT", shutdown)

dbg("SERVER", "standalone server ready")
