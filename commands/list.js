import { shared } from './_shared.js'

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function timeAgo(ts) {
  if (!ts) return null
  const secs = Math.floor((Date.now() - ts) / 1000)
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  return `${hrs}h ago`
}

function sessionLine(s, { shortPath }) {
  const parts = []
  const title = shared.titles.get(s.id) || s.title
  if (title) parts.push(`<b>${esc(title)}</b>`)
  parts.push(`<pre>${esc(shortPath(s.cwd))}</pre>`)
  const details = []
  if (s.gitBranch) details.push(esc(s.gitBranch))
  if (s.connectedAt) details.push(`started ${timeAgo(s.connectedAt)}`)
  const active = timeAgo(s.lastActive)
  if (active) details.push(`active ${active}`)
  if (details.length) parts.push(details.join(' · '))
  return parts.join('\n')
}

export const commands = {
  list: async (ctx, bot, state) => {
    if (ctx.chat?.type !== 'private') return true
    const access = state.loadAccess()
    const senderId = String(ctx.from?.id)
    if (!access.allowFrom.includes(senderId)) return true

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
      parts.push(`▶ /switch_${active.id} (active)\n${sessionLine(active, { shortPath })}`)
    }
    for (const s of others) {
      parts.push(`/switch_${s.id}\n${sessionLine(s, { shortPath })}`)
    }
    await ctx.reply(parts.join('\n\n'), { parse_mode: 'HTML' })
    return true
  },
}
