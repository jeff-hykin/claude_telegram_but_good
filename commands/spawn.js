import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const commands = {
  spawn: async (ctx, bot, state) => {
    if (ctx.chat?.type !== 'private') return true
    const access = state.loadAccess()
    const senderId = String(ctx.from?.id)
    if (!access.allowFrom.includes(senderId)) return true

    // Check for dtach, fall back to zellij/tmux
    let launcher = null
    try { execSync('which dtach', { stdio: 'ignore' }); launcher = 'dtach' } catch {}
    if (!launcher) {
      try { execSync('which zellij', { stdio: 'ignore' }); launcher = 'zellij' } catch {}
    }
    if (!launcher) {
      try { execSync('which tmux', { stdio: 'ignore' }); launcher = 'tmux' } catch {}
    }

    if (!launcher) {
      await ctx.reply('No session launcher found. Install dtach, zellij, or tmux.')
      return true
    }

    // Pre-assign the session ID so we know the switch command ahead of time
    const sessionId = state.generateName()
    const title = ctx.message?.text?.replace(/^\/spawn\s*/, '').trim() || undefined

    const sessionName = `claude-${sessionId}`
    const claudeCmd = 'claude --dangerously-skip-permissions --channels plugin:telegram@claude-plugins-official'
    const home = state.homedir()
    const stateDir = join(state.homedir(), '.claude', 'channels', 'telegram')
    const dtachSock = join(stateDir, `dtach-${sessionId}.sock`)

    // Strip env vars that would confuse the child Claude session
    const cleanEnv = { ...process.env }
    for (const key of Object.keys(cleanEnv)) {
      if (key.startsWith('CLAUDE_') || key.startsWith('MCP_')) {
        delete cleanEnv[key]
      }
    }
    delete cleanEnv.ZELLIJ
    delete cleanEnv.ZELLIJ_SESSION_NAME

    // Write pre-assigned session info for the new server to pick up on startup
    writeFileSync(join(stateDir, 'next_session.json'), JSON.stringify({
      id: sessionId,
      title: title || undefined,
      dtachSocket: launcher === 'dtach' ? dtachSock : undefined,
    }))

    try {
      if (launcher === 'dtach') {
        // -n = create detached, -E = disable detach char, -z = disable suspend
        execSync(
          `dtach -n "${dtachSock}" -Ez bash -c 'cd "${home}" && ${claudeCmd}'`,
          { env: cleanEnv, timeout: 5000, encoding: 'utf8' }
        )
      } else if (launcher === 'zellij') {
        const insideZellij = !!process.env.ZELLIJ
        if (insideZellij) {
          execSync(
            `zellij run --cwd "${home}" -n "${sessionName}" -- bash -c '${claudeCmd}'`,
            { env: cleanEnv, timeout: 5000, encoding: 'utf8' }
          )
        } else {
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

      const displayTitle = title ? ` (${title})` : ''
      await ctx.reply(`Spawned: /chat_${sessionId}${displayTitle}`)

      setTimeout(() => {
        state.setFocusedSession(sessionId)
      }, 1000)

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
