import { execSync } from 'child_process'

export const commands = {
  spawn_d: async (ctx, bot, state) => {
    if (ctx.chat?.type !== 'private') return true
    const access = state.loadAccess()
    const senderId = String(ctx.from?.id)
    if (!access.allowFrom.includes(senderId)) return true

    if (!state.isPrimary) {
      await ctx.reply('Only available on the primary.')
      return true
    }

    // Prefer zellij, fall back to tmux
    let launcher = null
    try { execSync('which zellij', { stdio: 'ignore' }); launcher = 'zellij' } catch {}
    if (!launcher) {
      try { execSync('which tmux', { stdio: 'ignore' }); launcher = 'tmux' } catch {}
    }

    if (!launcher) {
      await ctx.reply('Neither zellij nor tmux found. Install one to use /spawn_d.')
      return true
    }

    const sessionName = `claude-${state.randomBytes(3).toString('hex')}`
    const claudeCmd = 'claude --dangerously-skip-permissions --channels plugin:telegram@claude-plugins-official'
    const home = state.homedir()

    // Strip env vars that would confuse the child Claude session
    const cleanEnv = { ...process.env }
    for (const key of Object.keys(cleanEnv)) {
      if (key.startsWith('CLAUDE_') || key.startsWith('MCP_')) {
        delete cleanEnv[key]
      }
    }

    try {
      if (launcher === 'zellij') {
        execSync(
          `zellij action new-tab --name "${sessionName}" -- bash -c 'cd ${home} && ${claudeCmd}'`,
          { env: cleanEnv, timeout: 5000, encoding: 'utf8' }
        )
      } else {
        execSync(
          `tmux new-session -d -s "${sessionName}" -c "${home}" '${claudeCmd}'`,
          { env: cleanEnv, timeout: 5000, encoding: 'utf8' }
        )
      }
      await ctx.reply(`Spawned new session via ${launcher}: ${sessionName}\nIt should appear in /list shortly.`)
    } catch (err) {
      let detail = ''
      if (err instanceof Error) {
        detail = err.message
        if (err.stderr) detail += `\nstderr: ${err.stderr}`
        if (err.stdout) detail += `\nstdout: ${err.stdout}`
      } else {
        detail = String(err)
      }
      state.dbg('SPAWN', 'failed:', detail)
      await ctx.reply(`Failed to spawn via ${launcher}:\n${detail}`)
    }
    return true
  },
}
