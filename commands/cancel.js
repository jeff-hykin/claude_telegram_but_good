import { $ } from '../imports.js'

export const tips = [
    "/cancel will stop the current request",
]

export const descriptions = {
  cancel: "Stop the current request in the focused session",
}

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
        // Send Escape (0x1b) via dtach socket — triggers TUI cancel.
        // `.stdinText("\x1b")` pipes the byte directly; dax handles the
        // socket argument as a properly-quoted arg, so no shell-injection
        // risk from the session id.
        await $`dtach -p ${focused.dtachSocket}`
          .stdinText("\x1b")
          .timeout(3000)
        await ctx.reply(`Sent Escape to session ${focused.id} via dtach`)
      } else {
        // Fallback: SIGINT to Claude Code process
        Deno.kill(focused.pid, "SIGINT")
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
