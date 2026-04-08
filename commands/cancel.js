import { openSync, writeSync, closeSync } from 'fs'

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

    // Send Escape key to Claude Code's stdin via /proc/<pid>/fd/0
    // This triggers the TUI's cancel behavior (like pressing Esc)
    try {
      const fd = openSync(`/proc/${focused.pid}/fd/0`, 'w')
      writeSync(fd, '\x1b') // ESC byte
      closeSync(fd)
      await ctx.reply(`Sent Escape to Claude Code (PID ${focused.pid})`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      state.dbg('CANCEL', 'failed:', msg)
      await ctx.reply(`Cancel failed: ${msg}`)
    }
    return true
  },
}
