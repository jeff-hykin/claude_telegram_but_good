/**
 * Shared IPC protocol types and helpers for the standalone Telegram server
 * and MCP shim communication.
 *
 * Transport: Unix domain socket at ~/.claude/channels/telegram/ipc.sock
 * Framing: Newline-delimited JSON
 */

import type { Socket } from 'net'
import { homedir } from 'os'
import { join } from 'path'

export const STATE_DIR = process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'telegram')
export const ACCESS_FILE = join(STATE_DIR, 'access.json')
export const APPROVED_DIR = join(STATE_DIR, 'approved')
export const ENV_FILE = join(STATE_DIR, '.env')
export const IPC_SOCK = join(STATE_DIR, 'ipc.sock')
export const INBOX_DIR = join(STATE_DIR, 'inbox')
export const PID_FILE = join(STATE_DIR, 'server.pid')
export const LOG_FILE = join(homedir(), 'claud_telegram.log')

export type SessionInfo = {
  id: string
  pid: number
  cwd: string
  connectedAt: number
  title?: string
  lastActive?: number
  gitBranch?: string
}

export type ToolResult = {
  content: Array<{ type: string; text: string }>
  isError?: boolean
}

export type IpcMessage =
  // Session lifecycle
  | { type: 'register'; session: SessionInfo }
  | { type: 'registered'; sessions: SessionInfo[]; focusedId: string }
  | { type: 'unregister'; sessionId: string }
  // Channel events (Telegram → shim → Claude)
  | { type: 'channel_event'; content: string; meta: Record<string, string> }
  // Permission flow
  | { type: 'permission_request'; request_id: string; tool_name: string; description: string; input_preview: string }
  | { type: 'permission_reply'; request_id: string; behavior: string }
  // Session management
  | { type: 'session_list'; sessions: SessionInfo[]; focusedId: string; primaryId: string }
  | { type: 'set_title'; sessionId: string; title: string }
  // Tool call proxying (shim → server → shim)
  | { type: 'tool_request'; requestId: string; sessionId: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_response'; requestId: string; result: ToolResult }
  // Hook events (PreToolUse/PostToolUse from Claude Code hooks)
  | { type: 'hook_event'; sessionId: string; hook: 'PreToolUse' | 'PostToolUse'; tool_name: string; input_preview?: string; output_preview?: string; is_error?: boolean }

export function sendIpc(socket: Socket, msg: IpcMessage): void {
  try {
    socket.write(JSON.stringify(msg) + '\n')
  } catch {}
}

/**
 * Parse newline-delimited JSON from a socket data stream.
 * Returns parsed messages and updates the buffer reference.
 */
export function parseIpcMessages(buf: string, chunk: string): { messages: IpcMessage[]; remaining: string } {
  buf += chunk
  const messages: IpcMessage[] = []
  let nl: number
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    try {
      messages.push(JSON.parse(line) as IpcMessage)
    } catch {}
  }
  return { messages, remaining: buf }
}

// Debug logging
import { appendFileSync } from 'fs'

const DEBUG = true
export function dbgSync(label: string, ...args: unknown[]): void {
  if (!DEBUG) return
  const ts = new Date().toISOString()
  const line = `[TG-DBG ${ts}] ${label}: ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}\n`
  process.stderr.write(line)
  try { appendFileSync(LOG_FILE, line) } catch {}
}
