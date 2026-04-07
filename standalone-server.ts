#!/usr/bin/env npx tsx
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

import { Bot, GrammyError, InlineKeyboard } from 'grammy'
import type { ReactionTypeEmoji, Context } from 'grammy/types'
import { execSync } from 'child_process'
import { randomBytes } from 'crypto'
import {
  readFileSync, writeFileSync, appendFileSync, mkdirSync,
  readdirSync, rmSync, chmodSync, unlinkSync, existsSync,
} from 'fs'
import { createServer, type Socket } from 'net'
import { homedir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

import {
  STATE_DIR, ENV_FILE, IPC_SOCK, PID_FILE, INBOX_DIR,
  sendIpc, parseIpcMessages, dbgSync as dbg,
  type IpcMessage, type SessionInfo, type ToolResult,
} from './lib/protocol.ts'
import {
  loadAccess, readAccessFile, saveAccess, gate, checkApprovals,
  assertAllowedChat, type Access,
} from './lib/access.ts'
import { loadCommands, getHotCommands, type CommandHandler } from './lib/commands.ts'
import { createToolExecutor } from './lib/telegram-api.ts'
import {
  formatPreToolUse, formatPostToolUse,
  setActiveToolMessage, getActiveToolMessage, clearActiveToolMessage,
} from './lib/hooks.ts'

// Load .env
try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, '.claude-plugin', 'plugin.json'), 'utf8')).version as string
  } catch { return 'unknown' }
})()

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
const STATIC = process.env.TELEGRAM_ACCESS_MODE === 'static'

if (!TOKEN) {
  process.stderr.write(
    `telegram server: TELEGRAM_BOT_TOKEN required\n` +
    `  set in ${ENV_FILE}\n` +
    `  format: TELEGRAM_BOT_TOKEN=123456789:AAH...\n`,
  )
  process.exit(1)
}

dbg('SERVER', 'starting standalone server, TOKEN set:', !!TOKEN, 'STATIC:', STATIC)

// === PID file ===
mkdirSync(STATE_DIR, { recursive: true })
writeFileSync(PID_FILE, String(process.pid))

// === Session registry ===
const sessions = new Map<string, { socket: Socket; info: SessionInfo }>()
let focusedSessionId: string | null = null

// Message queue for when no sessions are connected
const messageQueue: Array<{ content: string; meta: Record<string, string> }> = []
const MAX_QUEUE_SIZE = 50

function allSessions(): SessionInfo[] {
  return Array.from(sessions.values()).map(s => s.info)
}

function setSessionTitle(sessionId: string, title: string): boolean {
  const session = sessions.get(sessionId)
  if (session) {
    session.info.title = title
    return true
  }
  return false
}

function getSessionTitle(sessionId: string): string | undefined {
  return sessions.get(sessionId)?.info.title
}

// === Bot ===
const bot = new Bot(TOKEN)
let botUsername = ''

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i
const pendingPermissions = new Map<string, { tool_name: string; description: string; input_preview: string }>()
const pendingCommandErrors = new Map<string, { cmdName: string; error: string; stack: string; text: string }>()

// Static access for static mode
const BOOT_ACCESS: Access | null = STATIC
  ? (() => {
      const a = readAccessFile()
      if (a.dmPolicy === 'pairing') {
        process.stderr.write('telegram server: static mode — dmPolicy "pairing" downgraded to "allowlist"\n')
        a.dmPolicy = 'allowlist'
      }
      a.pending = {}
      return a
    })()
  : null

// Tool executor
const toolExecutor = createToolExecutor(
  bot,
  TOKEN,
  BOOT_ACCESS,
  async (text, chat_id) => {
    const onReply = getHotCommands().get('__onReply')
    if (onReply) {
      try { await onReply({ text, chat_id } as any, bot, getCommandState()) } catch {}
    }
  },
)

// === Commands ===
const COMMANDS_DIR = join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, 'commands')
const CUSTOM_COMMANDS_DIR = join(homedir(), '.claude', 'telegram', 'custom_commands')

function getCommandState(): Record<string, unknown> {
  return {
    allSessions, get focusedSessionId() { return focusedSessionId },
    setFocusedSession(id: string) { focusedSessionId = id },
    setSessionTitle,
    SESSION_ID: 'server', get isPrimary() { return true },
    loadAccess: () => loadAccess(BOOT_ACCESS), secondaries: sessions,
    SESSION_PID: process.pid, SESSION_CWD: process.cwd(),
    deliverToFocused, sendIpc, bot,
    // No mcp object in standalone server — commands that need it should check
    mcp: null,
    dbg,
    letClaudeHandle: (ctx: any, text?: string) => {
      const content = text ?? ctx.message?.text ?? ''
      const from = ctx.from!
      const chat_id = String(ctx.chat!.id)
      const msgId = ctx.message?.message_id
      const meta: Record<string, string> = {
        chat_id,
        ...(msgId != null ? { message_id: String(msgId) } : {}),
        user: from.username ?? String(from.id),
        user_id: String(from.id),
        ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
      }
      deliverToFocused(content, meta)
    },
    execSync, randomBytes, homedir, PLUGIN_VERSION,
  }
}

loadCommands(COMMANDS_DIR, CUSTOM_COMMANDS_DIR).catch(() => {})

// === Message delivery ===

function deliverToFocused(content: string, meta: Record<string, string>): boolean {
  if (!focusedSessionId) {
    // No focused session — queue or respond
    messageQueue.push({ content, meta })
    if (messageQueue.length > MAX_QUEUE_SIZE) messageQueue.shift()
    dbg('QUEUE', 'queued message, queue size:', messageQueue.length)
    return false
  }
  const session = sessions.get(focusedSessionId)
  if (!session) {
    focusedSessionId = sessions.size > 0 ? sessions.keys().next().value! : null
    if (!focusedSessionId) {
      messageQueue.push({ content, meta })
      if (messageQueue.length > MAX_QUEUE_SIZE) messageQueue.shift()
      return false
    }
    return deliverToFocused(content, meta)
  }
  session.info.lastActive = Date.now()
  sendIpc(session.socket, { type: 'channel_event', content, meta })
  return true
}

function deliverPermissionToFocused(params: { request_id: string; tool_name: string; description: string; input_preview: string }): boolean {
  if (!focusedSessionId) return false
  const session = sessions.get(focusedSessionId)
  if (!session) return false
  sendIpc(session.socket, { type: 'permission_request', ...params })
  return true
}

function drainQueue(sessionId: string): void {
  const session = sessions.get(sessionId)
  if (!session || messageQueue.length === 0) return
  dbg('QUEUE', 'draining', messageQueue.length, 'queued messages to', sessionId)
  while (messageQueue.length > 0) {
    const msg = messageQueue.shift()!
    sendIpc(session.socket, { type: 'channel_event', content: msg.content, meta: msg.meta })
  }
}

// === IPC Server ===

const ipcServer = createServer(socket => {
  let buf = ''
  let sessionId: string | null = null

  socket.on('data', chunk => {
    const result = parseIpcMessages(buf, chunk.toString())
    buf = result.remaining
    for (const msg of result.messages) {
      handleShimMessage(socket, msg)
      if (msg.type === 'register') sessionId = msg.session.id
    }
  })

  socket.on('close', () => {
    if (sessionId) {
      dbg('IPC', 'session disconnected:', sessionId)
      sessions.delete(sessionId)
      if (focusedSessionId === sessionId) {
        focusedSessionId = sessions.size > 0 ? sessions.keys().next().value! : null
        dbg('IPC', 'focus moved to:', focusedSessionId ?? 'none')
      }
    }
  })

  socket.on('error', () => {})
})

function handleShimMessage(socket: Socket, msg: IpcMessage): void {
  switch (msg.type) {
    case 'register': {
      const info = msg.session
      dbg('IPC', 'session registered:', info.id, 'pid:', info.pid, 'cwd:', info.cwd)
      sessions.set(info.id, { socket, info })
      process.stderr.write(`telegram server: session ${info.id} connected (PID ${info.pid}, ${info.cwd})\n`)

      // If no focused session, focus this one
      if (!focusedSessionId) {
        focusedSessionId = info.id
        dbg('IPC', 'auto-focused session:', info.id)
      }

      // Send confirmation
      sendIpc(socket, {
        type: 'registered',
        sessions: allSessions(),
        focusedId: focusedSessionId ?? info.id,
      })

      // Drain queued messages
      if (focusedSessionId === info.id) {
        drainQueue(info.id)
      }
      break
    }

    case 'unregister': {
      dbg('IPC', 'session unregistered:', msg.sessionId)
      sessions.delete(msg.sessionId)
      if (focusedSessionId === msg.sessionId) {
        focusedSessionId = sessions.size > 0 ? sessions.keys().next().value! : null
      }
      break
    }

    case 'set_title': {
      setSessionTitle(msg.sessionId, msg.title)
      dbg('IPC', 'title set:', msg.sessionId, msg.title)
      break
    }

    case 'permission_request': {
      // Shim forwarding a CC permission request — show in Telegram
      const { request_id, tool_name, description, input_preview } = msg
      pendingPermissions.set(request_id, { tool_name, description, input_preview })
      const access = loadAccess(BOOT_ACCESS)
      const text = `🔐 Permission: ${tool_name}`
      const keyboard = new InlineKeyboard()
        .text('See more', `perm:more:${request_id}`)
        .text('✅ Allow', `perm:allow:${request_id}`)
        .text('❌ Deny', `perm:deny:${request_id}`)
      for (const chat_id of access.allowFrom) {
        void bot.api.sendMessage(chat_id, text, { reply_markup: keyboard }).catch(e => {
          process.stderr.write(`permission_request send to ${chat_id} failed: ${e}\n`)
        })
      }
      break
    }

    case 'permission_reply': {
      // Shim forwarding a permission reply — route to focused session
      const target = sessions.get(focusedSessionId ?? '')
      if (target) {
        sendIpc(target.socket, { type: 'permission_reply', request_id: msg.request_id, behavior: msg.behavior })
      }
      break
    }

    case 'tool_request': {
      // Shim requesting a tool call — execute and respond
      const { requestId, name, args } = msg
      void (async () => {
        // Handle non-bot tools locally
        if (name === 'reload') {
          const { loaded, errors } = await loadCommands(COMMANDS_DIR, CUSTOM_COMMANDS_DIR)
          const parts = [`Reloaded: ${loaded} command(s)`]
          if (errors.length > 0) parts.push(`\nErrors:\n${errors.join('\n')}`)
          sendIpc(socket, { type: 'tool_response', requestId, result: { content: [{ type: 'text', text: parts.join('') }] } })
          return
        }

        if (name === 'new_command') {
          const filename = args.filename as string
          const code = args.code as string
          if (!filename.endsWith('.js')) {
            sendIpc(socket, { type: 'tool_response', requestId, result: { content: [{ type: 'text', text: 'Error: filename must end in .js' }] } })
            return
          }
          mkdirSync(CUSTOM_COMMANDS_DIR, { recursive: true })
          writeFileSync(join(CUSTOM_COMMANDS_DIR, filename), code)
          const { loaded, errors } = await loadCommands(COMMANDS_DIR, CUSTOM_COMMANDS_DIR)
          const parts = [`Wrote ${join(CUSTOM_COMMANDS_DIR, filename)}\nReloaded: ${loaded} command(s)`]
          if (errors.length > 0) parts.push(`\nErrors:\n${errors.join('\n')}`)
          sendIpc(socket, { type: 'tool_response', requestId, result: { content: [{ type: 'text', text: parts.join('') }] } })
          return
        }

        if (name === 'enable_telegram_by_default') {
          const enabled = args.enabled as boolean
          const result = handleEnableTelegramByDefault(enabled)
          sendIpc(socket, { type: 'tool_response', requestId, result })
          return
        }

        // Bot API tools
        const result = await toolExecutor(name, args)
        sendIpc(socket, { type: 'tool_response', requestId, result })
      })()
      break
    }

    case 'hook_event': {
      // Tool call hook from shim — send status to Telegram
      void handleHookEvent(msg)
      break
    }
  }
}

// === Hook event handling ===

async function handleHookEvent(msg: Extract<IpcMessage, { type: 'hook_event' }>): Promise<void> {
  const access = loadAccess(BOOT_ACCESS)
  const sessionTitle = getSessionTitle(msg.sessionId)

  if (msg.hook === 'PreToolUse') {
    const text = formatPreToolUse(msg, sessionTitle)
    for (const chat_id of access.allowFrom) {
      try {
        const sent = await bot.api.sendMessage(chat_id, text)
        setActiveToolMessage(msg.sessionId, msg.tool_name, chat_id, sent.message_id)
      } catch (e) {
        dbg('HOOK', 'failed to send PreToolUse:', e)
      }
    }
  } else if (msg.hook === 'PostToolUse') {
    const text = formatPostToolUse(msg, sessionTitle)
    // Try to edit the PreToolUse message
    for (const chat_id of access.allowFrom) {
      const active = getActiveToolMessage(msg.sessionId, msg.tool_name)
      if (active && active.chatId === chat_id) {
        try {
          await bot.api.editMessageText(chat_id, active.messageId, text)
          clearActiveToolMessage(msg.sessionId, msg.tool_name)
        } catch {
          // Edit failed — send a new message
          await bot.api.sendMessage(chat_id, text).catch(() => {})
        }
      }
    }
  }
}

// === enable_telegram_by_default (local handler) ===

function handleEnableTelegramByDefault(enabled: boolean): ToolResult {
  const CHANNELS_FLAG = '--channels plugin:telegram@claude-plugins-official'
  const wrapperDir = join(homedir(), '.claude', 'bin')
  const wrapperPath = join(wrapperDir, 'claude')
  const rcFiles = [join(homedir(), '.zshrc'), join(homedir(), '.bashrc'), join(homedir(), '.bash_profile')]
  const pathLine = `export PATH="$HOME/.claude/bin:$PATH" # claude-telegram-wrapper`

  if (enabled) {
    let realClaude: string
    try {
      const cleanPath = (process.env.PATH ?? '').split(':').filter(p => !p.includes('.claude/bin')).join(':')
      realClaude = execSync('which claude', { encoding: 'utf8', env: { ...process.env, PATH: cleanPath }, timeout: 3000 }).trim()
    } catch {
      return { content: [{ type: 'text', text: 'Error: could not find the claude binary' }] }
    }

    mkdirSync(wrapperDir, { recursive: true })
    const wrapper = `#!/usr/bin/env bash\n# Auto-generated by claude-telegram-but-good\nexec "${realClaude}" ${CHANNELS_FLAG} "$@"\n`
    writeFileSync(wrapperPath, wrapper)
    chmodSync(wrapperPath, 0o755)

    for (const rc of rcFiles) {
      try {
        const content = readFileSync(rc, 'utf8')
        if (!content.includes('claude-telegram-wrapper')) {
          appendFileSync(rc, `\n${pathLine}\n`)
        }
      } catch {}
    }

    return { content: [{ type: 'text', text: `Enabled. Wrapper at ${wrapperPath} → ${realClaude} ${CHANNELS_FLAG}` }] }
  } else {
    try { unlinkSync(wrapperPath) } catch {}
    for (const rc of rcFiles) {
      try {
        const content = readFileSync(rc, 'utf8')
        if (content.includes('claude-telegram-wrapper')) {
          const cleaned = content.split('\n').filter(l => !l.includes('claude-telegram-wrapper')).join('\n')
          writeFileSync(rc, cleaned)
        }
      } catch {}
    }
    return { content: [{ type: 'text', text: `Disabled. Wrapper removed.` }] }
  }
}

// === Telegram bot handlers ===

function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;]/g, '_')
}

type AttachmentMeta = {
  kind: string
  file_id: string
  size?: number
  mime?: string
  name?: string
}

async function handleInbound(
  ctx: any,
  text: string,
  downloadImage: (() => Promise<string | undefined>) | undefined,
  attachment?: AttachmentMeta,
): Promise<void> {
  dbg('INBOUND', 'text:', text, 'from:', ctx.from?.id, 'chat:', ctx.chat?.id)
  const result = gate(ctx, botUsername, BOOT_ACCESS)
  dbg('INBOUND', 'gate result:', result.action)

  if (result.action === 'drop') return

  if (result.action === 'pair') {
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    const userId = String(ctx.from!.id)
    await ctx.reply(
      `${lead} — your user ID is ${userId}\n\nRun in Claude Code:\n/telegram:access pair ${result.code}\n\nOr add directly to access.json:\n"allowFrom": ["${userId}"]`,
    )
    return
  }

  const access = result.access
  const from = ctx.from!
  const chat_id = String(ctx.chat!.id)
  const msgId = ctx.message?.message_id

  // Permission-reply intercept
  const permMatch = PERMISSION_REPLY_RE.exec(text)
  if (permMatch) {
    const request_id = permMatch[2]!.toLowerCase()
    const behavior = permMatch[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny'

    const target = sessions.get(focusedSessionId ?? '')
    if (target) {
      sendIpc(target.socket, { type: 'permission_reply', request_id, behavior })
    }

    if (msgId != null) {
      const emoji = behavior === 'allow' ? '✅' : '❌'
      void bot.api.setMessageReaction(chat_id, msgId, [
        { type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] },
      ]).catch(() => {})
    }
    return
  }

  // Typing indicator
  void bot.api.sendChatAction(chat_id, 'typing').catch(() => {})

  // Ack reaction
  if (access.ackReaction && msgId != null) {
    void bot.api
      .setMessageReaction(chat_id, msgId, [
        { type: 'emoji', emoji: access.ackReaction as ReactionTypeEmoji['emoji'] },
      ])
      .catch(() => {})
  }

  const imagePath = downloadImage ? await downloadImage() : undefined

  const replyTo = ctx.message?.reply_to_message
  const meta: Record<string, string> = {
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

  const delivered = deliverToFocused(text, meta)
  if (!delivered) {
    // No sessions — tell the user
    await bot.api.sendMessage(chat_id, '💤 No active Claude sessions. Message queued — it will be delivered when a session connects.').catch(() => {})
  }
}

// Bot command handlers
bot.command('reload', async ctx => {
  if (ctx.chat?.type !== 'private') return
  const access = loadAccess(BOOT_ACCESS)
  const senderId = String(ctx.from?.id)
  if (!access.allowFrom.includes(senderId)) return

  const { loaded, errors } = await loadCommands(COMMANDS_DIR, CUSTOM_COMMANDS_DIR)
  const parts = [`Reloaded: ${loaded} command(s)`]
  if (errors.length > 0) parts.push(`\nErrors:\n${errors.join('\n')}`)
  await ctx.reply(parts.join(''))
})

// Inline button handler for permissions
bot.on('callback_query:data', async ctx => {
  const data = ctx.callbackQuery.data

  // Command error debug button
  const errMatch = /^cmderr:fix:([a-f0-9]+)$/.exec(data)
  if (errMatch) {
    const access = loadAccess(BOOT_ACCESS)
    const senderId = String(ctx.from.id)
    if (!access.allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    const errorId = errMatch[1]
    const errInfo = pendingCommandErrors.get(errorId)
    if (!errInfo) {
      await ctx.answerCallbackQuery({ text: 'Error details expired.' }).catch(() => {})
      return
    }
    pendingCommandErrors.delete(errorId)
    const isCustom = existsSync(join(homedir(), '.claude', 'telegram', 'custom_commands', errInfo.cmdName + '.js'))
    const fileLoc = isCustom
      ? `~/.claude/telegram/custom_commands/${errInfo.cmdName}.js`
      : `the commands/ directory in the plugin source`
    const debugMsg =
      `The Telegram command /${errInfo.cmdName} threw an error. ` +
      `Please fix it and hot-reload.\n\n` +
      `Error: ${errInfo.error}\n` +
      `Stack: ${errInfo.stack}\n\n` +
      `The command file is at: ${fileLoc}\n` +
      `The user's message was: ${errInfo.text}\n\n` +
      `After fixing, use the reload MCP tool to hot-reload the commands.`
    const chat_id = String(ctx.callbackQuery.message?.chat.id ?? ctx.from.id)
    const meta: Record<string, string> = {
      chat_id,
      user: ctx.from.username ?? String(ctx.from.id),
      user_id: String(ctx.from.id),
    }
    deliverToFocused(debugMsg, meta)
    await ctx.answerCallbackQuery({ text: 'Sent to Claude for debugging.' }).catch(() => {})
    const msg = ctx.callbackQuery.message
    if (msg && 'text' in msg && msg.text) {
      await ctx.editMessageText(`${msg.text}\n\n🔧 Sent to Claude for debugging.`).catch(() => {})
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
    await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
    return
  }
  const [, behavior, request_id] = m

  if (behavior === 'more') {
    const details = pendingPermissions.get(request_id)
    if (!details) {
      await ctx.answerCallbackQuery({ text: 'Details no longer available.' }).catch(() => {})
      return
    }
    const { tool_name, description, input_preview } = details
    let prettyInput: string
    try {
      prettyInput = JSON.stringify(JSON.parse(input_preview), null, 2)
    } catch {
      prettyInput = input_preview
    }
    const expanded =
      `🔐 Permission: ${tool_name}\n\n` +
      `tool_name: ${tool_name}\n` +
      `description: ${description}\n` +
      `input_preview:\n${prettyInput}`
    const keyboard = new InlineKeyboard()
      .text('✅ Allow', `perm:allow:${request_id}`)
      .text('❌ Deny', `perm:deny:${request_id}`)
    await ctx.editMessageText(expanded, { reply_markup: keyboard }).catch(() => {})
    await ctx.answerCallbackQuery().catch(() => {})
    return
  }

  // Route permission reply to focused session
  const target = sessions.get(focusedSessionId ?? '')
  if (target) {
    sendIpc(target.socket, { type: 'permission_reply', request_id: request_id!, behavior: behavior! })
  }
  pendingPermissions.delete(request_id!)
  const label = behavior === 'allow' ? '✅ Allowed' : '❌ Denied'
  await ctx.answerCallbackQuery({ text: label }).catch(() => {})
  const msg = ctx.callbackQuery.message
  if (msg && 'text' in msg && msg.text) {
    await ctx.editMessageText(`${msg.text}\n\n${label}`).catch(() => {})
  }
})

// Message handlers
bot.on('message:text', async ctx => {
  const text = ctx.message.text
  dbg('EVENT', 'message:text received:', text, 'from:', ctx.from?.id)

  // /switch_<id>
  const switchMatch = /^\/switch_([a-f0-9]+)$/i.exec(text)
  if (switchMatch) {
    const access = loadAccess(BOOT_ACCESS)
    const senderId = String(ctx.from?.id)
    if (!access.allowFrom.includes(senderId)) return

    const targetId = switchMatch[1].toLowerCase()
    const sessionList = allSessions()
    const target = sessionList.find(s => s.id === targetId)
    if (!target) {
      await ctx.reply(`Session "${targetId}" not found. Use /list to see available sessions.`)
      return
    }
    focusedSessionId = targetId
    const parts = [`Switched to session ${targetId}`]
    if (target.title) parts[0] += `: ${target.title}`
    await ctx.reply(parts.join('\n'))
    return
  }

  // __onMessage hook
  const onMsg = getHotCommands().get('__onMessage')
  if (onMsg) {
    try { await onMsg(ctx as any, bot, getCommandState()) } catch {}
  }

  // Hot-reloadable commands
  const cmdMatch = /^\/(\w+)/.exec(text)
  if (cmdMatch) {
    const cmdName = cmdMatch[1].toLowerCase()
    const handler = getHotCommands().get(cmdName)
    if (handler) {
      try {
        const handled = await handler(ctx as any, bot, getCommandState())
        if (handled) return
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        const errStack = err instanceof Error ? err.stack ?? '' : ''
        dbg('HOT', `command ${cmdName} error:`, err)
        const errorId = randomBytes(3).toString('hex')
        pendingCommandErrors.set(errorId, { cmdName, error: errMsg, stack: errStack, text })
        const keyboard = new InlineKeyboard()
          .text('🔧 Ask Claude to fix', `cmderr:fix:${errorId}`)
        await ctx.reply(`⚠️ /${cmdName} failed: ${errMsg}`, { reply_markup: keyboard }).catch(() => {})
      }
    }
  }

  await handleInbound(ctx, text, undefined)
})

bot.on('message:photo', async ctx => {
  const caption = ctx.message.caption ?? '(photo)'
  await handleInbound(ctx, caption, async () => {
    const photos = ctx.message.photo
    const best = photos[photos.length - 1]
    try {
      const file = await ctx.api.getFile(best.file_id)
      if (!file.file_path) return undefined
      const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`
      const res = await fetch(url)
      const buf = Buffer.from(await res.arrayBuffer())
      const ext = file.file_path.split('.').pop() ?? 'jpg'
      const path = join(INBOX_DIR, `${Date.now()}-${best.file_unique_id}.${ext}`)
      mkdirSync(INBOX_DIR, { recursive: true })
      writeFileSync(path, buf)
      return path
    } catch (err) {
      process.stderr.write(`telegram server: photo download failed: ${err}\n`)
      return undefined
    }
  })
})

bot.on('message:document', async ctx => {
  const doc = ctx.message.document
  const name = safeName(doc.file_name)
  const text = ctx.message.caption ?? `(document: ${name ?? 'file'})`
  await handleInbound(ctx, text, undefined, {
    kind: 'document', file_id: doc.file_id, size: doc.file_size, mime: doc.mime_type, name,
  })
})

bot.on('message:voice', async ctx => {
  const voice = ctx.message.voice
  const text = ctx.message.caption ?? '(voice message)'
  await handleInbound(ctx, text, undefined, {
    kind: 'voice', file_id: voice.file_id, size: voice.file_size, mime: voice.mime_type,
  })
})

bot.on('message:audio', async ctx => {
  const audio = ctx.message.audio
  const name = safeName(audio.file_name)
  const text = ctx.message.caption ?? `(audio: ${safeName(audio.title) ?? name ?? 'audio'})`
  await handleInbound(ctx, text, undefined, {
    kind: 'audio', file_id: audio.file_id, size: audio.file_size, mime: audio.mime_type, name,
  })
})

bot.on('message:video', async ctx => {
  const video = ctx.message.video
  const text = ctx.message.caption ?? '(video)'
  await handleInbound(ctx, text, undefined, {
    kind: 'video', file_id: video.file_id, size: video.file_size, mime: video.mime_type, name: safeName(video.file_name),
  })
})

bot.on('message:video_note', async ctx => {
  const vn = ctx.message.video_note
  await handleInbound(ctx, '(video note)', undefined, {
    kind: 'video_note', file_id: vn.file_id, size: vn.file_size,
  })
})

bot.on('message:sticker', async ctx => {
  const sticker = ctx.message.sticker
  const emoji = sticker.emoji ? ` ${sticker.emoji}` : ''
  await handleInbound(ctx, `(sticker${emoji})`, undefined, {
    kind: 'sticker', file_id: sticker.file_id, size: sticker.file_size,
  })
})

bot.catch(err => {
  dbg('ERROR', 'handler error:', err.error)
  process.stderr.write(`telegram server: handler error (polling continues): ${err.error}\n`)
})

// === Startup ===

process.on('unhandledRejection', err => {
  process.stderr.write(`telegram server: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`telegram server: uncaught exception: ${err}\n`)
})

// Approval polling
if (!STATIC) setInterval(() => checkApprovals(bot), 5000).unref()

// Clean up stale socket
try { unlinkSync(IPC_SOCK) } catch {}

ipcServer.listen(IPC_SOCK, () => {
  dbg('IPC', 'listening on', IPC_SOCK)
})

// Start polling
void (async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      dbg('POLL', 'calling bot.start(), attempt:', attempt)
      await bot.start({
        onStart: info => {
          botUsername = info.username
          dbg('POLL', 'bot started, polling as @' + info.username)
          process.stderr.write(`telegram server: polling as @${info.username} (standalone)\n`)
          bot.api.setMyCommands(
            [
              { command: 'start', description: 'Welcome and setup guide' },
              { command: 'help', description: 'What this bot can do' },
              { command: 'status', description: 'Check your pairing status' },
              { command: 'list', description: 'Show connected sessions' },
              { command: 'spawn_d', description: 'Launch a new Claude Code session' },
              { command: 'reload', description: 'Hot-reload command handlers' },
            ],
            { scope: { type: 'all_private_chats' } },
          ).catch(e => dbg('COMMANDS', 'setMyCommands failed:', e))
        },
      })
      return
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 409) {
        const delay = Math.min(1000 * attempt, 15000)
        process.stderr.write(`telegram server: 409 Conflict, retrying in ${delay / 1000}s\n`)
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      if (err instanceof Error && err.message === 'Aborted delay') return
      process.stderr.write(`telegram server: polling failed: ${err}\n`)
      return
    }
  }
})()

// Graceful shutdown
function shutdown(): void {
  process.stderr.write('telegram server: shutting down\n')
  for (const [, s] of sessions) s.socket.destroy()
  sessions.clear()
  ipcServer.close()
  try { unlinkSync(IPC_SOCK) } catch {}
  try { unlinkSync(PID_FILE) } catch {}
  setTimeout(() => process.exit(0), 2000)
  void Promise.resolve(bot.stop()).finally(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

dbg('SERVER', 'standalone server ready')
