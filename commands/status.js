import { execSync } from 'node:child_process'

export const tips = []

function listClaudeSessions() {
  try {
    const raw = execSync('ps aux', { encoding: 'utf8', timeout: 5000 })
    const lines = raw.split('\n')
    const sessions = []
    for (const line of lines) {
      if (
        (/\bclaude\b/i.test(line)) &&
        !line.includes('telegram') &&
        !line.includes('ps aux') &&
        !line.includes('grep')
      ) {
        const cols = line.trim().split(/\s+/)
        const pid = cols[1]
        const cmd = cols.slice(10).join(' ')
        if (pid && cmd) {
          sessions.push(`PID ${pid}: ${cmd}`)
        }
      }
    }
    return sessions
  } catch {
    return []
  }
}

export const descriptions = {
  status: "Check your pairing status",
}

export const commands = {
  status: async (ctx, bot, state) => {
    if (ctx.chat?.type !== 'private') return true
    const from = ctx.from
    if (!from) return true
    const senderId = String(from.id)
    const access = state.loadAccess()

    const parts = []

    // Pairing status
    if (access.allowFrom.includes(senderId)) {
      const name = from.username ? `@${from.username}` : senderId
      parts.push(`Paired as ${name}.`)
    } else {
      let found = false
      for (const [code, p] of Object.entries(access.pending)) {
        if (p.senderId === senderId) {
          parts.push(`Pending pairing — run in Claude Code:\n/telegram:access pair ${code}`)
          found = true
          break
        }
      }
      if (!found) {
        parts.push(`Not paired. Send me a message to get a pairing code.`)
      }
    }

    // Running Claude Code processes
    const procs = listClaudeSessions()
    if (procs.length > 0) {
      parts.push(`\nRunning Claude Code processes (${procs.length}):`)
      for (const s of procs) {
        parts.push(s)
      }
    } else {
      parts.push(`\nNo Claude Code processes detected.`)
    }

    await ctx.reply(parts.join('\n'))
    return true
  },
}
