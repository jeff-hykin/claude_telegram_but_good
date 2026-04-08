/**
 * PreToolUse/PostToolUse hook event formatting for Telegram.
 *
 * Hook events arrive from shims and get formatted into compact Telegram
 * status messages. PreToolUse creates a new message; PostToolUse edits it.
 */

// Track active tool call messages so PostToolUse can edit them
const activeToolMessages = new Map()

function toolKey(sessionId, toolName) {
    return `${sessionId}:${toolName}`
}

function truncate(s, max) {
    if (s.length <= max) {
        return s
    }
    return s.slice(0, max - 3) + "..."
}

export function formatPreToolUse(event, sessionTitle) {
    const label = sessionTitle ?? event.sessionId
    const preview = event.input_preview
        ? `\n${truncate(event.input_preview, 200)}`
        : ""
    return `\u2699\uFE0F [${label}] Running: ${event.tool_name}${preview}`
}

export function formatPostToolUse(event, sessionTitle) {
    const label = sessionTitle ?? event.sessionId
    const status = event.is_error ? "\u274C" : "\u2705"
    const preview = event.output_preview
        ? `\n${truncate(event.output_preview, 200)}`
        : ""
    return `${status} [${label}] Done: ${event.tool_name}${preview}`
}

export function setActiveToolMessage(sessionId, toolName, chatId, messageId) {
    activeToolMessages.set(toolKey(sessionId, toolName), { chatId, messageId })
}

export function getActiveToolMessage(sessionId, toolName) {
    return activeToolMessages.get(toolKey(sessionId, toolName))
}

export function clearActiveToolMessage(sessionId, toolName) {
    activeToolMessages.delete(toolKey(sessionId, toolName))
}
