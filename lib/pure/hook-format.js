// ---------------------------------------------------------------------------
// lib/pure/hook-format.js — Pre/PostToolUse hook event → Telegram Markdown.
//
// Two exports: formatPreToolUse and formatPostToolUse. Each takes a
// snake_case hook event shape (tool_name, input_preview, output_preview,
// is_error) and returns a rendered Markdown string — or `null` when the tool
// should be hidden from Telegram (currently: any mcp__plugin_telegram_*
// tool, to avoid echo loops).
//
// Pure: the only dependency is escapeMarkdown from ./markdown.js. No Map
// state, no filesystem I/O, no versionedImport — this file can be statically
// imported or loaded through versionedImport indifferently.
// ---------------------------------------------------------------------------

import { escapeMarkdown as esc } from "./markdown.js"

// ── Pure helpers ───────────────────────────────────────────────────────

function truncate(s, max) {
    if (s.length <= max) {
        return s
    }
    return s.slice(0, max - 3) + "..."
}

function parsePreview(raw) {
    try {
        return JSON.parse(raw)
    } catch (e) {
        // Previews are best-effort — a malformed payload is expected
        // (e.g. truncated strings) and shouldn't kill the render. The
        // formatter handles a null `input` throughout.
        return null
    }
}

function basename(path) {
    return path.split("/").pop() || path
}

/**
 * Split a shell command on `;`, `&&`, `||`, `|`, but not inside quotes.
 * Used so Bash previews can render each command on its own line.
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

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Returns null if the tool call should be hidden from Telegram.
 */
export function formatPreToolUse(event) {
    const tool = event.tool_name
    if (tool.startsWith("mcp__plugin_telegram_telegram__")) {
        return null
    }

    const input = parsePreview(event.input_preview)

    if (tool === "Read") {
        return `_📖 Reading_ \`${basename(input?.file_path ?? "")}\``
    }

    if (tool === "Bash") {
        const { header, cmdText } = formatBashCmd(input)
        const h = header ? `_${esc(header.trim())}_\n` : ""
        return `${h}\`\`\`\n${truncate(cmdText, 300)}\n\`\`\``
    }

    if (tool === "Grep") {
        return `_🔍 Grep_ \`${truncate(input?.pattern ?? "", 80)}\` _in_ \`${basename(input?.path ?? ".")}\``
    }

    if (tool === "Glob") {
        return `_🔍 Glob_ \`${input?.pattern ?? ""}\``
    }

    if (tool === "Edit") {
        return `_✏️ Editing_ \`${basename(input?.file_path ?? "")}\``
    }

    if (tool === "Write") {
        return `_📝 Writing_ \`${basename(input?.file_path ?? "")}\``
    }

    if (tool === "Agent") {
        return `_🤖 Agent: ${esc(input?.description ?? "")}_`
    }

    if (tool === "ToolSearch") {
        return `_🔍 ToolSearch_ \`${truncate(input?.query ?? "", 80)}\``
    }

    if (tool === "Skill") {
        return `_⚡ Skill: ${esc(input?.skill ?? "")}_`
    }

    if (tool === "WebSearch") {
        return `_🌐 WebSearch_ \`${truncate(input?.query ?? "", 80)}\``
    }

    if (tool === "WebFetch") {
        return `_🌐 Fetching_ \`${truncate(input?.url ?? "", 80)}\``
    }

    if (tool === "NotebookEdit") {
        return `_📓 NotebookEdit_ \`${basename(input?.file_path ?? "")}\``
    }

    // Task-management tool family. TaskCreate / TaskUpdate / TaskList
    // are lifecycle operations with no interesting identifier on the
    // input side. TaskGet / TaskStop / TaskOutput operate on a
    // specific task_id — render it the same way other tools render
    // their primary argument (`value`) so the spinner item stays a
    // single line.
    if (tool === "TaskCreate" || tool === "TaskUpdate" || tool === "TaskList") {
        return `_📋 ${esc(tool)}_`
    }
    if (tool === "TaskGet" || tool === "TaskStop" || tool === "TaskOutput") {
        const taskId = input?.task_id ?? input?.taskId ?? null
        const suffix = taskId ? ` \`${String(taskId)}\`` : ""
        return `_📋 ${esc(tool)}_${suffix}`
    }

    // Default: single line, tool name only. The raw input_preview
    // used to be appended here (truncated to 200 chars), but it's
    // almost always a JSON blob that doesn't render cleanly inside a
    // spinner item — the TaskStop case was a literal
    // {"message":"Successfully stopped ...","task_id":"..."} dump.
    // If a specific tool deserves richer rendering, add a branch
    // above. Don't let unknown tools leak their arg JSON into chat.
    return `_⚙️ ${esc(tool)}_`
}

export function formatPostToolUse(event) {
    const tool = event.tool_name
    if (tool.startsWith("mcp__plugin_telegram_telegram__")) {
        return null
    }

    const status = event.is_error ? "❌" : "☑️"
    const input = parsePreview(event.input_preview)

    if (tool === "Bash") {
        const { header, cmdText } = formatBashCmd(input)
        const output = event.output_preview ? parsePreview(event.output_preview) : null
        const stdout = output?.stdout ?? ""
        const outBlock = stdout ? `\n\`\`\`\n${truncate(stdout, 200)}\n\`\`\`` : ""
        const h = header ? `_${status} ${esc(header.trim())}_\n` : `${status} `
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
        return `_${status} Agent: ${esc(input?.description ?? "")}_`
    }

    if (tool === "ToolSearch") {
        const output = event.output_preview ? parsePreview(event.output_preview) : null
        const count = output?.matches?.length ?? 0
        return `_${status} ToolSearch_ \`${truncate(input?.query ?? "", 80)}\` _(${count} match${count !== 1 ? "es" : ""})_`
    }

    if (tool === "Skill") {
        return `_${status} Skill: ${esc(input?.skill ?? "")}_`
    }

    if (tool === "WebSearch") {
        return `_${status} WebSearch_ \`${truncate(input?.query ?? "", 80)}\``
    }

    if (tool === "WebFetch") {
        return `_${status} Fetched_ \`${truncate(input?.url ?? "", 80)}\``
    }

    if (tool === "NotebookEdit") {
        return `_${status} NotebookEdit_ \`${basename(input?.file_path ?? "")}\``
    }

    // Task-management family — see the pre-tool formatter for the
    // rationale. TaskStop / TaskGet / TaskOutput pass the task_id
    // through to the post-tool line so the spinner still shows
    // which task was touched without falling back to dumping the
    // tool's JSON return value.
    if (tool === "TaskCreate" || tool === "TaskUpdate" || tool === "TaskList") {
        return `_${status} ${esc(tool)}_`
    }
    if (tool === "TaskGet" || tool === "TaskStop" || tool === "TaskOutput") {
        const taskId = input?.task_id ?? input?.taskId ?? null
        const suffix = taskId ? ` \`${String(taskId)}\`` : ""
        return `_${status} ${esc(tool)}_${suffix}`
    }

    // Default: single line, tool name only (plus the ok/error
    // indicator). Earlier revisions appended a 200-char slice of
    // `output_preview` here, which for Task* tools meant dumping
    // things like {"message":"Successfully stopped task: ...",
    // "task_id":"...","command":"sleep 1800 && date ..."} into the
    // spinner. If a specific tool's output is worth rendering
    // (Bash, ToolSearch) it gets its own branch above; for unknown
    // tools the status icon + name carries enough signal and the
    // raw JSON would just be noise.
    return `_${status} ${esc(tool)}_`
}
