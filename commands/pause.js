import { execSync } from 'child_process'
import { shared } from './_shared.js'

const pausedSessions = shared.pausedSessions

function getClaudePid(serverPid) {
  try {
    const ppid = parseInt(execSync(`ps -o ppid= -p ${serverPid}`, { encoding: 'utf8', timeout: 3000 }).trim())
    return isNaN(ppid) || ppid <= 1 ? null : ppid
  } catch { return null }
}

export const commands = {
  pause: async (ctx, bot, state) => {
    if (ctx.chat?.type !== 'private') return true
    const access = state.loadAccess()
    if (!access.allowFrom.includes(String(ctx.from?.id))) return true
    if (!state.isPrimary) { await ctx.reply('Only available on the primary.'); return true }

    const focused = state.allSessions().find(s => s.id === state.focusedSessionId)
    if (!focused) { await ctx.reply('No focused session.'); return true }

    if (pausedSessions.has(focused.id)) {
      await ctx.reply('Session is already paused. Use /resume to continue.')
      return true
    }

    const claudePid = getClaudePid(focused.pid)
    if (!claudePid) { await ctx.reply('Could not find Claude Code process.'); return true }

    try {
      process.kill(claudePid, 'SIGTSTP')
      pausedSessions.add(focused.id)
      await ctx.reply(`Paused session ${focused.id} (PID ${claudePid})`)
    } catch (err) {
      await ctx.reply(`Pause failed: ${err instanceof Error ? err.message : err}`)
    }
    return true
  },

  resume: async (ctx, bot, state) => {
    if (ctx.chat?.type !== 'private') return true
    const access = state.loadAccess()
    if (!access.allowFrom.includes(String(ctx.from?.id))) return true
    if (!state.isPrimary) { await ctx.reply('Only available on the primary.'); return true }

    const focused = state.allSessions().find(s => s.id === state.focusedSessionId)
    if (!focused) { await ctx.reply('No focused session.'); return true }

    if (!pausedSessions.has(focused.id)) {
      await ctx.reply('Session is not paused.')
      return true
    }

    const claudePid = getClaudePid(focused.pid)
    if (!claudePid) { await ctx.reply('Could not find Claude Code process.'); return true }

    try {
      process.kill(claudePid, 'SIGCONT')
      pausedSessions.delete(focused.id)
      await ctx.reply(`Resumed session ${focused.id} (PID ${claudePid})`)
    } catch (err) {
      await ctx.reply(`Resume failed: ${err instanceof Error ? err.message : err}`)
    }
    return true
  },
}
