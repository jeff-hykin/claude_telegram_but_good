import { execSync } from 'child_process'

export const commands = {
  spawn: async (ctx, bot, state) => {
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
      await ctx.reply('Neither zellij nor tmux found. Install one to use /spawn.')
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
    // Also remove ZELLIJ so nested zellij commands don't conflict
    delete cleanEnv.ZELLIJ
    delete cleanEnv.ZELLIJ_SESSION_NAME

    try {
      if (launcher === 'zellij') {
        const insideZellij = !!process.env.ZELLIJ
        if (insideZellij) {
          // Already inside a zellij session — open a new pane
          execSync(
            `zellij run --cwd "${home}" -n "${sessionName}" -- bash -c '${claudeCmd}'`,
            { env: cleanEnv, timeout: 5000, encoding: 'utf8' }
          )
        } else {
          // Not inside zellij — create a background session then run in it
          execSync(
            `zellij attach -b --create "${sessionName}"`,
            { env: cleanEnv, timeout: 5000, encoding: 'utf8' }
          )
          execSync(
            `ZELLIJ_SESSION_NAME="${sessionName}" zellij run --cwd "${home}" -n "${sessionName}" -- bash -c '${claudeCmd}'`,
            { env: cleanEnv, timeout: 5000, encoding: 'utf8', shell: true }
          )
        }
      } else {
        execSync(
          `tmux new-session -d -s "${sessionName}" -c "${home}" '${claudeCmd}'`,
          { env: cleanEnv, timeout: 5000, encoding: 'utf8' }
        )
      }
      await ctx.reply(`Spawned via ${launcher}: ${sessionName}\nIt should appear in /list shortly.`)
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
