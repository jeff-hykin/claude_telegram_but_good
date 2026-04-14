// commands/peek.js — Action-returning hot command.
//
// Reads the dtach log file of a session, replays the tail of the raw
// terminal bytes through a VT100 emulator onto a virtual screen, and
// sends the rendered screen as an HTML <pre> block.

import { readFileSync } from "node:fs"
import { versionedImport } from "../lib/version.js"
const { loadAccess } = await versionedImport("../lib/access.js", import.meta)
const { dbg } = await versionedImport("../lib/logging.js", import.meta)
const { escapeHtml: escHtml } = await versionedImport("../lib/pure/html.js", import.meta)
const { renderTui, trimTrailingMarker } = await versionedImport("../lib/pure/tui-render.js", import.meta)

export const tips = [
    "/peek shows what a session is doing right now — no need to attach.",
    "/peek w=60 h=40 resizes the virtual screen; /peek &lt;session_id&gt; peeks at a specific session.",
    "/peek lines=1000 ingests more raw log history before replaying.",
]

const DEFAULT_WIDTH = 80
const DEFAULT_HEIGHT = 50
const DEFAULT_HISTORY_LINES = 3000 // we need a lot of history for things to render correctly

// Claude Code's TUI refuses to render below ~60 cols, so that's the
// min virtual screen width we can ask for. But Telegram on narrow
// phones is happier with ~50-char lines, so after rendering we run
// each line through a word-wrapper that preserves the original
// leading indent on wrapped continuation lines.
const SMART_WRAP_WIDTH = 40

// Telegram caps a single message at 4096 characters. Our reply wraps
// the rendered screen in `<header>\n<pre>...</pre>`, so we reserve a
// small overhead budget for the HTML tags, the separating newline, and
// any expansion from escapeHtml (e.g. `<` → `&lt;`).
const TELEGRAM_MAX_MESSAGE_CHARS = 4096
const HTML_WRAPPER_OVERHEAD_CHARS = 20
const TRUNCATION_PREFIX = "...\n"

/**
 * Wrap a single line to `maxWidth` columns, preserving its original
 * leading whitespace indent on continuation lines. Breaks at the last
 * space within the window when possible, hard-cuts otherwise.
 */
function smartWrapLine(line, maxWidth) {
    const stripped = line.replace(/\s+$/, "")
    if (stripped.length <= maxWidth) { return stripped }
    const indent = stripped.match(/^\s*/)[0]
    const bodyWidth = Math.max(1, maxWidth - indent.length)
    let remaining = stripped.slice(indent.length)
    const pieces = []
    while (remaining.length > bodyWidth) {
        let breakAt = remaining.lastIndexOf(" ", bodyWidth)
        if (breakAt <= 0) {
            breakAt = bodyWidth
        }
        pieces.push(remaining.slice(0, breakAt).replace(/\s+$/, ""))
        remaining = remaining.slice(breakAt).replace(/^\s+/, "")
    }
    if (remaining.length > 0) { pieces.push(remaining) }
    return pieces.map((p) => indent + p).join("\n")
}

function smartWrap(text, maxWidth) {
    return text.split("\n").map((l) => smartWrapLine(l, maxWidth)).join("\n")
}

export const descriptions = {
    peek: "Show the current virtual screen of a session",
}

function reply(chatId, text, options) {
    return { effects: [{ type: "send_text_to_user", chatId, text, ...(options ? { options } : {}) }] }
}

export const commands = {
    peek: (event, core) => {
        if (event.chatType !== "private") { return { effects: [] } }
        const access = loadAccess()
        if (!access.allowFrom.includes(String(event.userId ?? ""))) {
            return { effects: [] }
        }

        const argText = (event.text ?? "").replace(/^\/peek\s*/, "").trim()
        const args = argText.split(/\s+/).filter(Boolean)

        let targetId = null
        let width = DEFAULT_WIDTH
        let height = DEFAULT_HEIGHT
        let historyLines = DEFAULT_HISTORY_LINES
        for (const arg of args) {
            const kv = arg.match(/^([whl]|w|h|lines|width|height)=(\d+)$/i)
            if (kv) {
                const key = kv[1].toLowerCase()
                const val = parseInt(kv[2], 10)
                if (key === "w" || key === "width") { width = val }
                else if (key === "h" || key === "height") { height = val }
                else if (key === "l" || key === "lines") { historyLines = val }
                continue
            }
            if (/^\d+$/.test(arg)) {
                historyLines = parseInt(arg, 10)
            } else {
                targetId = arg
            }
        }

        const sessionsMap = core.chatSessions ?? {}
        const sessions = Object.values(sessionsMap)
        let session = null
        if (targetId) {
            session = sessions.find(s => s.id === targetId)
            if (!session) {
                return reply(event.chatId, `Session "${targetId}" not found. Use /list to see available sessions.`)
            }
        } else {
            const focusedId = core.chatState?.focusedSessionId
            if (focusedId) {
                session = sessions.find(s => s.id === focusedId)
            }
            if (!session && sessions.length > 0) {
                session = sessions[0]
            }
        }
        if (!session) { return reply(event.chatId, "No active sessions.") }

        const dtachSocket = session.dtachSocket
        if (!dtachSocket) {
            return reply(event.chatId, `Session "${session.id}" has no dtach socket — can't find log file.`)
        }
        const logPath = dtachSocket.replace(/\.sock$/, ".log")

        let content
        try {
            content = readFileSync(logPath, "utf8")
        } catch (e) {
            dbg("PEEK", `read ${logPath} failed:`, e)
            return reply(event.chatId, `No log file found for session "${session.id}".`)
        }
        if (!content.trim()) {
            return reply(event.chatId, `Log file for session "${session.id}" is empty.`)
        }

        const rawLines = content.split(/\r?\n/)
        const ingest = rawLines.slice(-historyLines).join("\n")

        let rendered
        try {
            rendered = renderTui(ingest, { width, height, ansi: false, trim: true })
            rendered = trimTrailingMarker(rendered)
            rendered = smartWrap(rendered, SMART_WRAP_WIDTH)
        } catch (e) {
            dbg("PEEK", "renderTui failed:", e)
            return reply(event.chatId, `Failed to render session "${session.id}".`)
        }
        if (!rendered.trim()) {
            return reply(event.chatId, `Log file for session "${session.id}" rendered empty.`)
        }

        const header = `${session.id}${session.title ? ` (${session.title})` : ""} [${width}x${height}]:`
        let body = rendered
        const bodyBudget = TELEGRAM_MAX_MESSAGE_CHARS - header.length - HTML_WRAPPER_OVERHEAD_CHARS
        if (body.length > bodyBudget) {
            body = TRUNCATION_PREFIX + body.slice(-(bodyBudget - TRUNCATION_PREFIX.length))
        }

        return reply(
            event.chatId,
            `${escHtml(header)}\n<pre>${escHtml(body)}</pre>`,
            { parse_mode: "HTML" },
        )
    },
}
