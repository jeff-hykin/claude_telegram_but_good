import { readFileSync } from 'node:fs'

export const tips = [
    "/peek shows what a session is doing right now — no need to attach.",
    "/peek 100 shows more output, /peek <session_id> peeks at a specific session.",
]

const DEFAULT_LINES = 40

// Claude Code UI section markers
const SECTION_MARKERS = /[◯✻✳✶✢←⏺]/

/**
 * Strip all terminal escape sequences from raw terminal output
 * and extract just the meaningful content, discarding layout/positioning.
 */
function extractWords(raw) {
    let text = raw
        // Clear screen commands
        .replace(/\x1b\[2J|\x1b\[H|\x1bc/g, '\n---\n')
        // Cursor positioning - these move text around, creating the garbled effect
        .replace(/\x1b\[\d+;\d+[Hf]/g, ' ')  // Absolute positioning
        .replace(/\x1b\[\d*[ABCD]/g, ' ')     // Up/down/left/right
        .replace(/\x1b\[\d*[KJ]/g, ' ')       // Erase line/screen
        .replace(/\x1b\[\d*C/g, ' ')          // Cursor forward
        .replace(/\x1b\[[\d;]*[mG]/g, '')     // Colors, graphics, column positioning
        // OSC sequences: \x1b] ... (ST or BEL terminated)
        .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
        // CSI sequences: \x1b[ ... letter/tilde (catch-all for remaining)
        .replace(/\x1b\[[0-9;?]*[a-zA-Z~@]/g, '')
        // DEC private sequences
        .replace(/\x1b[>=<#]/g, '')
        // Charset sequences
        .replace(/\x1b[()][0-9A-Za-z]/g, '')
        // Any remaining escape sequences
        .replace(/\x1b./g, '')
        // Control chars (keep \t \n \r)
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
        // DEC query responses that lost their prefix
        .replace(/>[0-9]+[a-z]/g, '')
        .replace(/<[a-z]/g, '')

    // Split into lines and clean each line
    const lines = text.split(/\r?\n/)
    const cleanLines = []

    for (const line of lines) {
        const cleaned = line
            // Remove isolated single characters that look like cursor artifacts
            .replace(/\b[✻✶*✢·⏵◯⎿❯]\s+[a-z]\s+/g, ' ')
            // Remove number/symbol fragments like "1 2 3 4 5"
            .replace(/\b[\d✻✶*✢·]+(?:\s+[\d✻✶*✢·])*\b/g, ' ')
            // Collapse runs of symbols/box-drawing
            .replace(/[─━│┃┌┐└┘├┤┬┴┼╔╗╚╝╠╣╦╩╬═║]{3,}/g, ' --- ')
            .replace(/[▐▌▛▜▘▝▗▖█▀▄▞▟▙▚░▒▓]{2,}/g, '')
            // Clean up excessive whitespace
            .replace(/\s+/g, ' ')
            .trim()

        if (cleaned && cleaned.length > 2) {
            cleanLines.push(cleaned)
        }
    }

    return cleanLines.join(' ')
}

// Claude Code streams thinking tokens by re-rendering the same region on
// every tick, so the raw log contains many overlapping copies of the same
// thinking block with progressively more text. Within a run of consecutive
// "Thinking…" markers (no tool-use / section marker between them), keep
// only the last copy — that one has the final, fullest text.
function collapseThinking(text) {
    const OTHER_SECTION = /[⏺◯✳✶✢←]/
    const markers = []
    const re = /Thinking…/g
    let m
    while ((m = re.exec(text)) !== null) {
        markers.push(m.index)
    }
    if (markers.length < 2) return text

    const toRemove = []
    for (let i = 0; i < markers.length - 1; i++) {
        const between = text.slice(markers[i] + 'Thinking…'.length, markers[i + 1])
        if (!OTHER_SECTION.test(between)) {
            toRemove.push([markers[i], markers[i + 1]])
        }
    }
    if (toRemove.length === 0) return text

    let out = ''
    let cursor = 0
    for (const [s, e] of toRemove) {
        out += text.slice(cursor, s)
        cursor = e
    }
    out += text.slice(cursor)
    return out
}

export const descriptions = {
    peek: "Show recent output of a session",
}

export const commands = {
    peek: async (ctx, bot, state) => {
        if (ctx.chat?.type !== 'private') return true
        const access = state.loadAccess()
        const senderId = String(ctx.from?.id)
        if (!access.allowFrom.includes(senderId)) return true

        // Parse optional line count or session id from args
        const argText = (ctx.message?.text ?? '').replace(/^\/peek\s*/, '').trim()
        const args = argText.split(/\s+/).filter(Boolean)

        let targetId = null
        let lineCount = DEFAULT_LINES

        for (const arg of args) {
            if (/^\d+$/.test(arg)) {
                lineCount = parseInt(arg, 10)
            } else {
                targetId = arg
            }
        }

        // Find the session
        const sessions = state.allSessions()
        let session = null

        if (targetId) {
            session = sessions.find(s => s.id === targetId)
            if (!session) {
                await ctx.reply(`Session "${targetId}" not found. Use /list to see available sessions.`)
                return true
            }
        } else {
            const focusedId = state.focusedSessionId
            if (focusedId) {
                session = sessions.find(s => s.id === focusedId)
            }
            if (!session && sessions.length > 0) {
                session = sessions[0]
            }
        }

        if (!session) {
            await ctx.reply('No active sessions.')
            return true
        }

        // Derive log path from dtach socket path
        const dtachSocket = session.dtachSocket
        if (!dtachSocket) {
            await ctx.reply(`Session "${session.id}" has no dtach socket — can't find log file.`)
            return true
        }

        const logPath = dtachSocket.replace(/\.sock$/, '.log')

        let content
        try {
            content = readFileSync(logPath, 'utf8')
        } catch {
            await ctx.reply(`No log file found for session "${session.id}".`)
            return true
        }

        if (!content.trim()) {
            await ctx.reply(`Log file for session "${session.id}" is empty.`)
            return true
        }

        const words = collapseThinking(extractWords(content))
        if (!words) {
            await ctx.reply(`Log file for session "${session.id}" is empty.`)
            return true
        }

        // Take the last N words worth of content (approximate lines as ~10 words each)
        const wordList = words.split(' ')
        const approxWords = lineCount * 10
        const tail = wordList.slice(-approxWords).join(' ')

        const header = `${session.id}${session.title ? ` (${session.title})` : ''}:`
        // Telegram message limit is 4096 chars
        let body = tail
        if (header.length + body.length + 10 > 4096) {
            body = body.slice(-(4096 - header.length - 10))
            body = '...' + body
        }

        // Try with code block formatting, fall back to plain text
        const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        try {
            await ctx.reply(`${escHtml(header)}\n<pre>${escHtml(body)}</pre>`, { parse_mode: 'HTML' })
        } catch (e) {
            state.dbg("PEEK", "HTML send failed, falling back to plain:", e)
            await ctx.reply(`${header}\n${body}`)
        }
        return true
    },
}
