// Dynamic import with cache-busting so hot-reload picks up edits to _shared.js
const { shared } = await import(`./_shared.js#${Math.random()}`)

export const tips = [
    "Tap a session ID from /list to switch to it.",
    "Replying to a message that has /chat_<id> at the top will always send the response to that chat (even if its not your currently-active session)",
]

// MarkdownV2 requires escaping these characters
function esc(s) {
    return s.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1')
}

function timeAgo(ts) {
    if (!ts) {
        return null
    }
    const secs = Math.floor((Date.now() - ts) / 1000)
    if (secs < 60) {
        return `${secs}s ago`
    }
    const mins = Math.floor(secs / 60)
    if (mins < 60) {
        return `${mins}m ago`
    }
    const hrs = Math.floor(mins / 60)
    return `${hrs}h ago`
}

function sessionBlock(s, { shortPath, isActive }) {
    const lines = []

    // Title as bold
    const title = shared.titles.get(s.id) || s.title || s.id
    const marker = isActive ? " \\[active\\]" : ""
    lines.push(`*${esc(title)}*${marker}`)

    // Bullet list with emojis
    const active = timeAgo(s.lastActive)
    if (active) {
        lines.push(`  \u2022 \u26A1 active: ${esc(active)}`)
    }
    if (s.connectedAt) {
        lines.push(`  \u2022 \uD83D\uDD52 started: ${esc(timeAgo(s.connectedAt))}`)
    }
    if (s.gitBranch) {
        lines.push(`  \u2022 \uD83C\uDF3F branch: \`${esc(s.gitBranch)}\``)
    }
    const sp = shortPath(s.cwd)
    if (sp === "~") {
        lines.push(`  \u2022 \uD83D\uDCC2 dir: \`\\(home dir\\)\``)
    } else {
        lines.push(`  \u2022 \uD83D\uDCC2 dir: \`${esc(sp)}\``)
    }
    if (s.recentMessages && s.recentMessages.length > 0) {
        for (const msg of s.recentMessages) {
            const icon = msg.role === "bot" ? "\uD83E\uDD16" : "\uD83D\uDDE3"
            lines.push(`  ${icon} _${esc(msg.text)}_`)
        }
    }

    // Chat command at the bottom
    lines.push(`  \u2022 /chat\\_${esc(s.id)}`)

    return lines.join('\n')
}

export const commands = {
    list: async (ctx, bot, state) => {
        if (ctx.chat?.type !== 'private') {
            return true
        }
        const access = state.loadAccess()
        const senderId = String(ctx.from?.id)
        if (!access.allowFrom.includes(senderId)) {
            return true
        }

        if (!state.isPrimary) {
            await ctx.reply('This session is a secondary — /list is only available on the primary.')
            return true
        }

        const sessions = state.allSessions()
        if (sessions.length === 0) {
            await ctx.reply('No sessions connected.')
            return true
        }

        const home = state.homedir()
        const shortPath = (p) => p.startsWith(home) ? '~' + p.slice(home.length) : p

        const active = sessions.find(s => s.id === state.focusedSessionId)
        const others = sessions.filter(s => s.id !== state.focusedSessionId)

        const parts = []
        if (active) {
            parts.push(sessionBlock(active, { shortPath, isActive: true }))
        }
        for (const s of others) {
            parts.push(sessionBlock(s, { shortPath, isActive: false }))
        }
        await ctx.reply(parts.join('\n\n'), { parse_mode: 'MarkdownV2' })
        return true
    },
}
