// Dynamic import with cache-busting so hot-reload picks up edits to _shared.js
const { shared } = await import(`./_shared.js#${Math.random()}`)

export const tips = [
    "/pause suspends the whole claude process — it won't use resources until you /resume.",
]

const pausedSessions = shared.pausedSessions

export const commands = {
  pause: async (ctx, bot, state) => {
    if (ctx.chat?.type !== 'private') return true
    const access = state.loadAccess()
    if (!access.allowFrom.includes(String(ctx.from?.id))) return true

    const focused = state.allSessions().find(s => s.id === state.focusedSessionId)
    if (!focused) { await ctx.reply('No focused session.'); return true }

    if (pausedSessions.has(focused.id)) {
      await ctx.reply('Session is already paused. Use /resume to continue.')
      return true
    }

    // focused.pid is the Claude Code process (shim reports process.ppid)
    try {
      process.kill(focused.pid, 'SIGTSTP')
      pausedSessions.add(focused.id)
      await ctx.reply(`Paused session ${focused.id} (PID ${focused.pid})`)
    } catch (err) {
      await ctx.reply(`Pause failed: ${err instanceof Error ? err.message : err}`)
    }
    return true
  },

  resume: async (ctx, bot, state) => {
    if (ctx.chat?.type !== 'private') return true
    const access = state.loadAccess()
    if (!access.allowFrom.includes(String(ctx.from?.id))) return true

    const focused = state.allSessions().find(s => s.id === state.focusedSessionId)
    if (!focused) { await ctx.reply('No focused session.'); return true }

    if (!pausedSessions.has(focused.id)) {
      await ctx.reply('Session is not paused.')
      return true
    }

    // focused.pid is the Claude Code process (shim reports process.ppid)
    try {
      process.kill(focused.pid, 'SIGCONT')
      pausedSessions.delete(focused.id)
      await ctx.reply(`Resumed session ${focused.id} (PID ${focused.pid})`)
    } catch (err) {
      await ctx.reply(`Resume failed: ${err instanceof Error ? err.message : err}`)
    }
    return true
  },
}
