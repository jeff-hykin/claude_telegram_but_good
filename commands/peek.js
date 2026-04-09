import { readFileSync } from 'node:fs'

const DEFAULT_LINES = 40

/**
 * Strip all terminal escape sequences from raw terminal output
 * and extract just the words, discarding layout/positioning.
 */
function extractWords(raw) {
    let text = raw
        // Replace cursor-forward (e.g. \x1b[1C, \x1b[2C) with a space
        .replace(/\x1b\[\d*C/g, ' ')
        // OSC sequences: \x1b] ... (ST or BEL terminated)
        .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
        // CSI sequences: \x1b[ ... letter/tilde
        .replace(/\x1b\[[0-9;?]*[a-zA-Z~]/g, '')
        // DEC private: \x1b > \x1b = \x1b < etc
        .replace(/\x1b[>=<]/g, '')
        // Charset sequences
        .replace(/\x1b[()][0-9A-Za-z]/g, '')
        // Any remaining escape + char
        .replace(/\x1b./g, '')
        // Control chars (keep \t \n \r)
        .replace(/[\x00-\x08\x0e-\x1f\x7f]/g, '')
        // DEC query responses that lost their \x1b prefix (e.g. >0q, >4m, <u)
        .replace(/>[0-9]+[a-z]/g, '')
        .replace(/<[a-z]/g, '')
        // Collapse runs of box-drawing / line chars into a single separator
        .replace(/[─━│┃┌┐└┘├┤┬┴┼╔╗╚╝╠╣╦╩╬═║]{3,}/g, '---')
        // Collapse runs of block elements (logo art)
        .replace(/[▐▌▛▜▘▝▗▖█▀▄▞▟▙▚░▒▓]{2,}/g, '')

    // Extract words (sequences of non-whitespace printable chars)
    const words = text.match(/\S+/g) || []
    return words.join(' ')
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

        const words = extractWords(content)
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
        try {
            // Escape backticks inside the body so they don't break the code block
            const safeBody = body.replace(/`/g, "'")
            await ctx.reply(`${header}\n\`\`\`\n${safeBody}\n\`\`\``, { parse_mode: 'Markdown' })
        } catch {
            // Plain text fallback
            await ctx.reply(`${header}\n${body}`)
        }
        return true
    },
}
