/**
 * PreToolUse/PostToolUse hook event formatting for Telegram.
 *
 * Hook events arrive from shims and get formatted into compact Telegram
 * status messages. PreToolUse creates a new message; PostToolUse edits it.
 */

import type { IpcMessage } from "./protocol.ts"

export type HookEvent = Extract<IpcMessage, { type: "hook_event" }>

// Track active tool call messages so PostToolUse can edit them
const activeToolMessages = new Map<string, { chatId: string; messageId: number }>()

function toolKey(sessionId: string, toolName: string): string {
  return `${sessionId}:${toolName}`
}

/**
 * Format a PreToolUse event into a Telegram message.
 */
export function formatPreToolUse(event: HookEvent, sessionTitle?: string): string {
  const label = sessionTitle ?? event.sessionId
  const preview = event.input_preview
    ? `\n${truncate(event.input_preview, 200)}`
    : ""
  return `⚙️ [${label}] Running: ${event.tool_name}${preview}`
}

/**
 * Format a PostToolUse event for editing the PreToolUse message.
 */
export function formatPostToolUse(event: HookEvent, sessionTitle?: string): string {
  const label = sessionTitle ?? event.sessionId
  const status = event.is_error ? "❌" : "✅"
  const preview = event.output_preview
    ? `\n${truncate(event.output_preview, 200)}`
    : ""
  return `${status} [${label}] Done: ${event.tool_name}${preview}`
}

export function setActiveToolMessage(sessionId: string, toolName: string, chatId: string, messageId: number): void {
  activeToolMessages.set(toolKey(sessionId, toolName), { chatId, messageId })
}

export function getActiveToolMessage(sessionId: string, toolName: string): { chatId: string; messageId: number } | undefined {
  return activeToolMessages.get(toolKey(sessionId, toolName))
}

export function clearActiveToolMessage(sessionId: string, toolName: string): void {
  activeToolMessages.delete(toolKey(sessionId, toolName))
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 3) + "..."
}
