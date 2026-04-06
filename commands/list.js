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
      const marker = s.id === state.focusedSessionId ? '>> ' : '   '
      const label = s.id === state.SESSION_ID ? ' (primary)' : ''
      return `${marker}/switch_${s.id}${label}\n      \`${s.cwd}\``
    })
    await ctx.reply(`Sessions (${sessions.length}):\n\n${lines.join('\n\n')}`)
    return true
  },
}
