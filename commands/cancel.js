import { execSync } from 'node:child_process'

export const tips = [
    "/cancel will stop the current request",
]

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

    try {
      if (focused.dtachSocket) {
        // Send Escape via dtach socket — triggers TUI cancel
        execSync(`printf '\\033' | dtach -p "${focused.dtachSocket}"`, {
          timeout: 3000,
          encoding: 'utf8',
          shell: true,
        })
        await ctx.reply(`Sent Escape to session ${focused.id} via dtach`)
      } else {
        // Fallback: SIGINT to Claude Code process
        process.kill(focused.pid, 'SIGINT')
        await ctx.reply(`Sent SIGINT to Claude Code (PID ${focused.pid})`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      state.dbg('CANCEL', 'failed:', msg)
      await ctx.reply(`Cancel failed: ${msg}`)
    }
    return true
  },
}
