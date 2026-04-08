export const commands = {
  cancel: async (ctx, bot, state) => {
    if (ctx.chat?.type !== 'private') return true
    const access = state.loadAccess()
    const senderId = String(ctx.from?.id)
    if (!access.allowFrom.includes(senderId)) return true

    const sessions = state.allSessions()
    const focused = sessions.find(s => s.id === state.focusedSessionId)
    if (!focused) {
      await ctx.reply('No focused session.')
      return true
    }

    // focused.pid is the Claude Code process (shim reports process.ppid)
    try {
      process.kill(focused.pid, 'SIGINT')
      await ctx.reply(`Sent SIGINT to Claude Code (PID ${focused.pid})`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      state.dbg('CANCEL', 'failed:', msg)
      await ctx.reply(`Cancel failed: ${msg}`)
    }
    return true
  },
}
