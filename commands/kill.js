import { execSync } from 'child_process'

function getClaudePid(serverPid) {
  try {
    const ppid = parseInt(execSync(`ps -o ppid= -p ${serverPid}`, { encoding: 'utf8', timeout: 3000 }).trim())
    return isNaN(ppid) || ppid <= 1 ? null : ppid
  } catch { return null }
}

export const commands = {
  fkill: async (ctx, bot, state) => {
    if (ctx.chat?.type !== 'private') return true
    const access = state.loadAccess()
    if (!access.allowFrom.includes(String(ctx.from?.id))) return true
    if (!state.isPrimary) { await ctx.reply('Only available on the primary.'); return true }

    const focused = state.allSessions().find(s => s.id === state.focusedSessionId)
    if (!focused) { await ctx.reply('No focused session.'); return true }

    const claudePid = getClaudePid(focused.pid)
    if (!claudePid) { await ctx.reply('Could not find Claude Code process.'); return true }

    try {
      process.kill(claudePid, 'SIGKILL')
      await ctx.reply(`Sent SIGKILL to Claude Code (PID ${claudePid})`)
    } catch (err) {
      await ctx.reply(`fkill failed: ${err instanceof Error ? err.message : err}`)
    }
    return true
  },

  relay_shutdown: async (ctx, bot, state) => {
    if (ctx.chat?.type !== 'private') return true
    const access = state.loadAccess()
    if (!access.allowFrom.includes(String(ctx.from?.id))) return true

    // Kill all server instances (secondaries + primary) without touching Claude sessions
    const sessions = state.allSessions()
    for (const s of sessions) {
      try { process.kill(s.pid, 'SIGKILL') } catch {}
    }
    await ctx.reply('Telegram relay shut down. Claude sessions are still running.')
    process.exit(0)
  },

  fkill_all: async (ctx, bot, state) => {
    if (ctx.chat?.type !== 'private') return true
    const access = state.loadAccess()
    if (!access.allowFrom.includes(String(ctx.from?.id))) return true
    if (!state.isPrimary) { await ctx.reply('Only available on the primary.'); return true }

    await ctx.reply('Killing all Claude sessions. Note I cannot respond now because all Claude sessions have been killed. Please restart me manually.')

    const sessions = state.allSessions()
    for (const s of sessions) {
      const claudePid = getClaudePid(s.pid)
      if (claudePid) {
        try { process.kill(claudePid, 'SIGKILL') } catch {}
      }
    }
    return true
  },
}
