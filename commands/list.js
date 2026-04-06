// HTML entities escape for Telegram HTML parse_mode
function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
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

    const lines = sessions.map(s => {
      const focused = s.id === state.focusedSessionId
      const marker = focused ? '▶ ' : '   '
      const label = s.id === state.SESSION_ID ? ' (primary)' : ''
      // Use the last directory name as a short title
      const title = s.cwd.split('/').filter(Boolean).pop() || s.cwd
      return `${marker}/switch_${s.id}${label}\n      <b>${esc(title)}</b>  <code>${esc(s.cwd)}</code>`
    })
    await ctx.reply(`Sessions (${sessions.length}):\n\n${lines.join('\n\n')}`, { parse_mode: 'HTML' })
    return true
  },
}
