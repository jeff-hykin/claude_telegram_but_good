export const tips = [
    "/kill asks claude to stop, /fkill doesn't",
    "if you ever want a nuclear option, try /fkill_all",
]

export const descriptions = {
  kill: "Ask the focused session to stop (SIGINT)",
  fkill: "Force kill the focused session (SIGTERM)",
  fkill_all: "Force kill all Claude sessions",
  relay_shutdown: "Shut down the Telegram relay (sessions keep running)",
}

export const commands = {
  kill: async (ctx, bot, state) => {
    if (ctx.chat?.type !== 'private') return true
    const access = state.loadAccess()
    if (!access.allowFrom.includes(String(ctx.from?.id))) return true

    const focused = state.allSessions().find(s => s.id === state.focusedSessionId)
    if (!focused) { await ctx.reply('No focused session.'); return true }

    try {
      process.kill(focused.pid, 'SIGINT')
      await ctx.reply(`Sent SIGINT to Claude Code (PID ${focused.pid})`)
    } catch (err) {
      await ctx.reply(`kill failed: ${err instanceof Error ? err.message : err}`)
    }
    return true
  },

  fkill: async (ctx, bot, state) => {
    if (ctx.chat?.type !== 'private') return true
    const access = state.loadAccess()
    if (!access.allowFrom.includes(String(ctx.from?.id))) return true

    const focused = state.allSessions().find(s => s.id === state.focusedSessionId)
    if (!focused) { await ctx.reply('No focused session.'); return true }

    try {
      process.kill(focused.pid, 'SIGTERM')
      await ctx.reply(`Sent SIGTERM to Claude Code (PID ${focused.pid})`)
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
