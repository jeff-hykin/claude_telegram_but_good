/**
 * PreToolUse/PostToolUse hook event formatting for Telegram.
 *
 * Hook events arrive from shims and get formatted into compact Telegram
 * status messages. PreToolUse creates a new message; PostToolUse edits it.
 */

// Track active tool call messages so PostToolUse can edit them
const activeToolMessages = new Map()

// Track the last hook message per chat for collapsing consecutive messages
// { chatId -> { messageId, text, sessionId } }
const lastHookMessage = new Map()

const COLLAPSE_LIMIT = 3000  // edit instead of new message if under this

function toolKey(sessionId, toolName) {
    return `${sessionId}:${toolName}`
}

export function getLastHookMessage(chatId) {
    return lastHookMessage.get(chatId)
}

export function setLastHookMessage(chatId, messageId, text, sessionId) {
    lastHookMessage.set(chatId, { messageId, text, sessionId })
}

export function clearLastHookMessage(chatId) {
    lastHookMessage.delete(chatId)
}

function truncate(s, max) {
    if (s.length <= max) {
        return s
    }
    return s.slice(0, max - 3) + "..."
}

function parsePreview(raw) {
    try {
        return JSON.parse(raw)
    } catch {
        return null
    }
}

function basename(path) {
    return path.split("/").pop() || path
}

/**
 * Split a shell command on ; && || | but not inside quotes.
 */
function splitShellCommands(cmd) {
    const parts = []
    let current = ""
    let inSingle = false
    let inDouble = false
    let escaped = false
    for (const ch of cmd) {
        if (escaped) {
            current += ch
            escaped = false
            continue
        }
        if (ch === "\\" && !inSingle) {
            escaped = true
            current += ch
            continue
        }
        if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; continue }
        if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; continue }
        if (!inSingle && !inDouble && (ch === ";" || ch === "&" || ch === "|")) {
            // consume consecutive operator chars
            if (current.trim()) { parts.push(current.trim()) }
            current = ""
            continue
        }
        current += ch
    }
    if (current.trim()) { parts.push(current.trim()) }
    return parts
}

function formatBashCmd(input) {
    const cmd = input?.command ?? ""
    const desc = input?.description
    const parts = splitShellCommands(cmd)
    const cmdText = parts.join("\n")
    const header = desc ? `❯❯ thought: ${desc}\n` : ""
    return { header, cmdText }
}

/**
 * Returns null if the tool call should be hidden from Telegram.
 */
export function formatPreToolUse(event, sessionTitle) {
    const tool = event.tool_name
    if (tool.startsWith("mcp__plugin_telegram_telegram__")) {
        return null
    }

    const input = parsePreview(event.input_preview)

    if (tool === "Read") {
        return `_\uD83D\uDCD6 Reading_ \`${basename(input?.file_path ?? "")}\``
    }

    if (tool === "Bash") {
        const { header, cmdText } = formatBashCmd(input)
        const h = header ? `_${header.trim()}_\n` : ""
        return `${h}\`\`\`\n${truncate(cmdText, 300)}\n\`\`\``
    }

    if (tool === "Grep") {
        return `_\uD83D\uDD0D Grep_ \`${truncate(input?.pattern ?? "", 80)}\` _in_ \`${basename(input?.path ?? ".")}\``
    }

    if (tool === "Glob") {
        return `_\uD83D\uDD0D Glob_ \`${input?.pattern ?? ""}\``
    }

    if (tool === "Edit") {
        return `_\u270F\uFE0F Editing_ \`${basename(input?.file_path ?? "")}\``
    }

    if (tool === "Write") {
        return `_\uD83D\uDCDD Writing_ \`${basename(input?.file_path ?? "")}\``
    }

    if (tool === "Agent") {
        return `_\uD83E\uDD16 Agent: ${input?.description ?? ""}_`
    }

    // Default
    const preview = event.input_preview
        ? `\n${truncate(event.input_preview, 200)}`
        : ""
    return `_\u2699\uFE0F ${tool}${preview}_`
}

export function formatPostToolUse(event, sessionTitle) {
    const tool = event.tool_name
    if (tool.startsWith("mcp__plugin_telegram_telegram__")) {
        return null
    }

    const status = event.is_error ? "\u274C" : "☑️"
    const input = parsePreview(event.input_preview)

    if (tool === "Bash") {
        const { header, cmdText } = formatBashCmd(input)
        const output = event.output_preview ? parsePreview(event.output_preview) : null
        const stdout = output?.stdout ?? ""
        const outBlock = stdout ? `\n\`\`\`\n${truncate(stdout, 200)}\n\`\`\`` : ""
        const h = header ? `_${status} ${header.trim()}_\n` : `${status} `
        return `${h}\`\`\`\n${truncate(cmdText, 200)}\n\`\`\`${outBlock}`
    }

    if (tool === "Read") {
        return `_${status} Read_ \`${basename(input?.file_path ?? "")}\``
    }

    if (tool === "Edit") {
        return `_${status} Edited_ \`${basename(input?.file_path ?? "")}\``
    }

    if (tool === "Write") {
        return `_${status} Wrote_ \`${basename(input?.file_path ?? "")}\``
    }

    if (tool === "Grep") {
        return `_${status} Grep_ \`${truncate(input?.pattern ?? "", 80)}\` _in_ \`${basename(input?.path ?? ".")}\``
    }

    if (tool === "Glob") {
        return `_${status} Glob_ \`${input?.pattern ?? ""}\``
    }

    if (tool === "Agent") {
        return `_${status} Agent: ${input?.description ?? ""}_`
    }

    // Default
    const preview = event.output_preview
        ? `\n${truncate(event.output_preview, 200)}`
        : ""
    return `_${status} ${tool}${preview}_`
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
