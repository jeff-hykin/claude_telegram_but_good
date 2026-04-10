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
    for (let i = 0; i < cmd.length; i++) {
        const ch = cmd[i]
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
            if (current.trim()) { parts.push(current.trim()) }
            current = ""
            // Skip consecutive operator chars (&&, ||, etc.)
            while (i + 1 < cmd.length && (cmd[i + 1] === "&" || cmd[i + 1] === "|")) { i++ }
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
// All formatting uses HTML parse_mode for Telegram
function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

export function formatPreToolUse(event) {
    const tool = event.tool_name
    if (tool.startsWith("mcp__plugin_telegram_telegram__")) {
        return null
    }

    const input = parsePreview(event.input_preview)

    if (tool === "Read") {
        return `<i>\uD83D\uDCD6 Reading</i> <code>${esc(basename(input?.file_path ?? ""))}</code>`
    }

    if (tool === "Bash") {
        const { header, cmdText } = formatBashCmd(input)
        const h = header ? `<i>${esc(header.trim())}</i>\n` : ""
        return `${h}<pre>${esc(truncate(cmdText, 300))}</pre>`
    }

    if (tool === "Grep") {
        return `<i>\uD83D\uDD0D Grep</i> <code>${esc(truncate(input?.pattern ?? "", 80))}</code> <i>in</i> <code>${esc(basename(input?.path ?? "."))}</code>`
    }

    if (tool === "Glob") {
        return `<i>\uD83D\uDD0D Glob</i> <code>${esc(input?.pattern ?? "")}</code>`
    }

    if (tool === "Edit") {
        return `<i>\u270F\uFE0F Editing</i> <code>${esc(basename(input?.file_path ?? ""))}</code>`
    }

    if (tool === "Write") {
        return `<i>\uD83D\uDCDD Writing</i> <code>${esc(basename(input?.file_path ?? ""))}</code>`
    }

    if (tool === "Agent") {
        return `<i>\uD83E\uDD16 Agent: ${esc(input?.description ?? "")}</i>`
    }

    if (tool === "ToolSearch") {
        return `<i>\uD83D\uDD0D ToolSearch</i> <code>${esc(truncate(input?.query ?? "", 80))}</code>`
    }

    if (tool === "Skill") {
        return `<i>\u26A1 Skill: ${esc(input?.skill ?? "")}</i>`
    }

    if (tool === "WebSearch") {
        return `<i>\uD83C\uDF10 WebSearch</i> <code>${esc(truncate(input?.query ?? "", 80))}</code>`
    }

    if (tool === "WebFetch") {
        return `<i>\uD83C\uDF10 Fetching</i> <code>${esc(truncate(input?.url ?? "", 80))}</code>`
    }

    if (tool === "NotebookEdit") {
        return `<i>\uD83D\uDCD3 NotebookEdit</i> <code>${esc(basename(input?.file_path ?? ""))}</code>`
    }

    if (tool === "TaskCreate" || tool === "TaskUpdate" || tool === "TaskList") {
        return `<i>\uD83D\uDCCB ${esc(tool)}</i>`
    }

    // Default
    const preview = event.input_preview
        ? `\n${esc(truncate(event.input_preview, 200))}`
        : ""
    return `<i>\u2699\uFE0F ${esc(tool)}</i>${preview}`
}

export function formatPostToolUse(event) {
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
        const outBlock = stdout ? `\n<pre>${esc(truncate(stdout, 200))}</pre>` : ""
        const h = header ? `<i>${status} ${esc(header.trim())}</i>\n` : `${status} `
        return `${h}<pre>${esc(truncate(cmdText, 200))}</pre>${outBlock}`
    }

    if (tool === "Read") {
        return `<i>${status} Read</i> <code>${esc(basename(input?.file_path ?? ""))}</code>`
    }

    if (tool === "Edit") {
        return `<i>${status} Edited</i> <code>${esc(basename(input?.file_path ?? ""))}</code>`
    }

    if (tool === "Write") {
        return `<i>${status} Wrote</i> <code>${esc(basename(input?.file_path ?? ""))}</code>`
    }

    if (tool === "Grep") {
        return `<i>${status} Grep</i> <code>${esc(truncate(input?.pattern ?? "", 80))}</code> <i>in</i> <code>${esc(basename(input?.path ?? "."))}</code>`
    }

    if (tool === "Glob") {
        return `<i>${status} Glob</i> <code>${esc(input?.pattern ?? "")}</code>`
    }

    if (tool === "Agent") {
        return `<i>${status} Agent: ${esc(input?.description ?? "")}</i>`
    }

    if (tool === "ToolSearch") {
        const output = event.output_preview ? parsePreview(event.output_preview) : null
        const count = output?.matches?.length ?? 0
        return `<i>${status} ToolSearch</i> <code>${esc(truncate(input?.query ?? "", 80))}</code> <i>(${count} match${count !== 1 ? "es" : ""})</i>`
    }

    if (tool === "Skill") {
        return `<i>${status} Skill: ${esc(input?.skill ?? "")}</i>`
    }

    if (tool === "WebSearch") {
        return `<i>${status} WebSearch</i> <code>${esc(truncate(input?.query ?? "", 80))}</code>`
    }

    if (tool === "WebFetch") {
        return `<i>${status} Fetched</i> <code>${esc(truncate(input?.url ?? "", 80))}</code>`
    }

    if (tool === "NotebookEdit") {
        return `<i>${status} NotebookEdit</i> <code>${esc(basename(input?.file_path ?? ""))}</code>`
    }

    if (tool === "TaskCreate" || tool === "TaskUpdate" || tool === "TaskList") {
        return `<i>${status} ${esc(tool)}</i>`
    }

    // Default
    const preview = event.output_preview
        ? `\n${esc(truncate(event.output_preview, 200))}`
        : ""
    return `<i>${status} ${esc(tool)}</i>${preview}`
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
