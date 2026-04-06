import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function readScheduledTasks(homeDir) {
  const tasksDir = join(homeDir, '.claude', 'scheduled-tasks')
  const tasks = []
  let dirs
  try {
    dirs = readdirSync(tasksDir, { withFileTypes: true })
  } catch {
    return tasks
  }

  for (const entry of dirs) {
    if (!entry.isDirectory()) continue
    const skillFile = join(tasksDir, entry.name, 'SKILL.md')
    try {
      const content = readFileSync(skillFile, 'utf8')
      // Parse frontmatter
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
      let name = entry.name
      let description = ''
      let prompt = content

      if (fmMatch) {
        const fm = fmMatch[1]
        prompt = fmMatch[2].trim()
        const nameMatch = fm.match(/^name:\s*(.+)$/m)
        const descMatch = fm.match(/^description:\s*(.+)$/m)
        if (nameMatch) name = nameMatch[1].trim()
        if (descMatch) description = descMatch[1].trim()
      }

      tasks.push({ name, description, prompt: prompt.slice(0, 100), dir: entry.name })
    } catch {}
  }
  return tasks
}

export const commands = {
  cron: async (ctx, bot, state) => {
    if (ctx.chat?.type !== 'private') return true
    const access = state.loadAccess()
    const senderId = String(ctx.from?.id)
    if (!access.allowFrom.includes(senderId)) return true

    const home = state.homedir()
    const parts = []

    // Desktop scheduled tasks (from filesystem)
    const tasks = readScheduledTasks(home)
    if (tasks.length > 0) {
      parts.push(`<b>Scheduled Tasks</b> (${tasks.length})`)
      parts.push('')
      for (const t of tasks) {
        let line = `📋 <b>${esc(t.name)}</b>`
        if (t.description) line += `\n   ${esc(t.description)}`
        if (t.prompt) line += `\n   <i>${esc(t.prompt)}${t.prompt.length >= 100 ? '...' : ''}</i>`
        parts.push(line)
      }
    } else {
      parts.push('<b>Scheduled Tasks</b>')
      parts.push('No desktop scheduled tasks found.')
    }

    parts.push('')
    parts.push('<b>Session Cron Jobs (/loop)</b>')
    parts.push('Session cron jobs are in-memory only and cannot be listed externally.')
    parts.push('Use /loop inside a Claude Code session to manage them.')

    await ctx.reply(parts.join('\n'), { parse_mode: 'HTML' })
    return true
  },
}
