import { execSync } from 'child_process'

// Find child processes of a given PID (the claude process under the MCP server)
function findClaudeChildPid(serverPid) {
  try {
    // Get all processes whose parent is serverPid
    const out = execSync(`ps -o pid,ppid,comm`, { encoding: 'utf8', timeout: 3000 })
    const lines = out.trim().split('\n').slice(1)

    // Walk the process tree from serverPid to find the claude process
    const children = []
    const queue = [serverPid]
    while (queue.length) {
      const parent = queue.shift()
      for (const line of lines) {
        const cols = line.trim().split(/\s+/)
        const pid = parseInt(cols[0])
        const ppid = parseInt(cols[1])
        const comm = cols.slice(2).join(' ')
        if (ppid === parent) {
          children.push({ pid, comm })
          queue.push(pid)
        }
      }
    }

    // Find the claude process in the tree
    const claude = children.find(c => /\bclaude\b/i.test(c.comm))
    return claude?.pid
  } catch {
    return null
  }
}

export const commands = {
  cancel: async (ctx, bot, state) => {
    if (ctx.chat?.type !== 'private') return true
    const access = state.loadAccess()
    const senderId = String(ctx.from?.id)
    if (!access.allowFrom.includes(senderId)) return true

    if (!state.isPrimary) {
      await ctx.reply('Only available on the primary.')
      return true
    }

    const sessions = state.allSessions()
    const focused = sessions.find(s => s.id === state.focusedSessionId)
    if (!focused) {
      await ctx.reply('No focused session.')
      return true
    }

    // The session PID is the MCP server process (server.ts).
    // Claude Code is the parent that spawned it — send SIGINT to the parent.
    try {
      const serverPid = focused.pid
      // Get the parent PID (Claude Code) of the server process
      const ppidOut = execSync(`ps -o ppid= -p ${serverPid}`, { encoding: 'utf8', timeout: 3000 }).trim()
      const claudePid = parseInt(ppidOut)

      if (isNaN(claudePid) || claudePid <= 1) {
        await ctx.reply('Could not find Claude Code process.')
        return true
      }

      process.kill(claudePid, 'SIGINT')
      await ctx.reply(`Sent SIGINT to Claude Code (PID ${claudePid})`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      state.dbg('CANCEL', 'failed:', msg)
      await ctx.reply(`Cancel failed: ${msg}`)
    }
    return true
  },
}
