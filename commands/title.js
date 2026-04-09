import { execSync } from 'node:child_process'
// Dynamic import with cache-busting so hot-reload picks up edits to _shared.js
const { shared } = await import(`./_shared.js#${Math.random()}`)

export const tips = [
    "/title without any argument will auto-generate a title",
    "use /title <name> to label your claude sessions",
]

function autoTitle(session) {
  const parts = []
  const dirName = session.cwd.split('/').filter(Boolean).pop() || session.cwd
  parts.push(dirName)
  let branch = session.gitBranch
  if (!branch) {
    try {
      branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: session.cwd, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
    } catch {}
  }
  if (branch && branch !== 'main' && branch !== 'master') {
    parts.push(`(${branch})`)
  }
  return parts.join(' ')
}

export const commands = {
  title: async (ctx, bot, state) => {
    if (ctx.chat?.type !== 'private') return true
    const access = state.loadAccess()
    const senderId = String(ctx.from?.id)
    if (!access.allowFrom.includes(senderId)) return true

    if (!state.isPrimary) {
      await ctx.reply('Only available on the primary.')
      return true
    }

    const text = ctx.message?.text || ''
    let title = text.replace(/^\/title\s*/i, '').trim()

    const focused = state.allSessions().find(s => s.id === state.focusedSessionId)
    if (!focused) {
      await ctx.reply('No focused session.')
      return true
    }

    if (!title) {
      title = autoTitle(focused)
    }

    shared.titles.set(focused.id, title)
    await ctx.reply(`Title: ${title}`)
    return true
  },
}
