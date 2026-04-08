export const commands = {
  fkill: async (ctx, bot, state) => {
    if (ctx.chat?.type !== 'private') return true
    const access = state.loadAccess()
    if (!access.allowFrom.includes(String(ctx.from?.id))) return true

    const focused = state.allSessions().find(s => s.id === state.focusedSessionId)
    if (!focused) { await ctx.reply('No focused session.'); return true }

    // focused.pid is the Claude Code process (shim reports process.ppid)
    try {
      process.kill(focused.pid, 'SIGKILL')
      await ctx.reply(`Sent SIGKILL to Claude Code (PID ${focused.pid})`)
    } catch (err) {
      await ctx.reply(`fkill failed: ${err instanceof Error ? err.message : err}`)
    }
    return true
  },

  relay_shutdown: async (ctx, bot, state) => {
    if (ctx.chat?.type !== 'private') return true
    const access = state.loadAccess()
    if (!access.allowFrom.includes(String(ctx.from?.id))) return true

    await ctx.reply('Telegram relay shut down. Claude sessions are still running.')
    process.exit(0)
  },

  fkill_all: async (ctx, bot, state) => {
    if (ctx.chat?.type !== 'private') return true
    const access = state.loadAccess()
    if (!access.allowFrom.includes(String(ctx.from?.id))) return true

    await ctx.reply('Killing all Claude sessions.')

    const sessions = state.allSessions()
    for (const s of sessions) {
      try { process.kill(s.pid, 'SIGKILL') } catch {}
    }
    return true
  },
}
