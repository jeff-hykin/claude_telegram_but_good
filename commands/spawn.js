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
    try { state.execSync('which zellij', { stdio: 'ignore' }); launcher = 'zellij' } catch {}
    if (!launcher) {
      try { state.execSync('which tmux', { stdio: 'ignore' }); launcher = 'tmux' } catch {}
    }

    if (!launcher) {
      await ctx.reply('Neither zellij nor tmux found. Install one to use /spawn_d.')
      return true
    }

    const sessionName = `claude-${state.randomBytes(3).toString('hex')}`
    const claudeCmd = 'claude --dangerously-skip-permissions --channels plugin:telegram@claude-plugins-official'
    const home = state.homedir()

    try {
      if (launcher === 'zellij') {
        state.execSync(`zellij action new-tab --name "${sessionName}" -- bash -c 'cd ${home} && ${claudeCmd}'`, { stdio: 'ignore', timeout: 5000 })
      } else {
        state.execSync(`tmux new-session -d -s "${sessionName}" -c "${home}" '${claudeCmd}'`, { stdio: 'ignore', timeout: 5000 })
      }
      await ctx.reply(`Spawned new session via ${launcher}: ${sessionName}\nIt should appear in /list shortly.`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      state.dbg('SPAWN', 'failed:', msg)
      await ctx.reply(`Failed to spawn: ${msg}`)
    }
    return true
  },
}
