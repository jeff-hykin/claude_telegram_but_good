import { execSync } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
// Dynamic import with cache-busting so hot-reload picks up edits to protocol.js
const { STATE_DIR } = await import(`../lib/protocol.js#${Math.random()}`)

/**
 * After dtach spawns Claude, poll the log file for the "trust this folder"
 * prompt. If detected, send Enter to accept it.
 */
function watchForTrustPrompt(dtachSock, logFile, maxWaitMs = 15000) {
    const start = Date.now()
    const poll = () => {
        if (Date.now() - start > maxWaitMs) { return }
        try {
            if (!existsSync(logFile)) {
                setTimeout(poll, 500)
                return
            }
            const raw = readFileSync(logFile, 'utf8')
            // Strip escape sequences to get plain text
            const text = raw
                .replace(/\x1b\[\d*C/g, ' ')
                .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
                .replace(/\x1b\[[0-9;?]*[a-zA-Z~]/g, '')
                .replace(/\x1b[>=<]/g, '')
                .replace(/\x1b[()][0-9A-Za-z]/g, '')
                .replace(/\x1b./g, '')
                .replace(/[\x00-\x08\x0e-\x1f\x7f]/g, '')
            if (/trust this folder|trust this project|Yes,?\s*I\s*trust/i.test(text)) {
                // Send Enter key via dtach -p
                try {
                    execSync(`printf '\\n' | dtach -p "${dtachSock}"`, { timeout: 3000 })
                } catch { /* ignore */ }
                return
            }
        } catch { /* file not ready yet */ }
        setTimeout(poll, 500)
    }
    setTimeout(poll, 1000)
}

export const tips = [
    "/spawn <name> gives your session a title so it's easy to find later.",
    "Sessions launched with /spawn run headless — use /peek to see what they're doing.",
    "Spawned sessions can be re-attached from the terminal with `cbg resume` when you're back at your computer.",
]

export const descriptions = {
  spawn: "Launch a new Claude Code session",
}

export const commands = {
  spawn: async (ctx, bot, state) => {
    if (ctx.chat?.type !== 'private') return true
    const access = state.loadAccess()
    const senderId = String(ctx.from?.id)
    if (!access.allowFrom.includes(senderId)) return true

    // Check for dtach
    try { execSync('which dtach', { stdio: 'ignore' }) } catch {
      await ctx.reply('dtach not found. Install it with: brew install dtach / apt-get install dtach / nix profile install nixpkgs#dtach')
      return true
    }

    // Pre-assign the session ID so we know the switch command ahead of time
    const sessionId = state.generateName()
    const title = ctx.message?.text?.replace(/^\/spawn\s*/, '').trim() || undefined

    // Read permission args from config file
    let permArgs = ''
    try {
        permArgs = readFileSync(join(STATE_DIR, 'permission_args'), 'utf8').trim()
    } catch {
        // no permission config — use defaults
    }
    const claudeCmd = `claude ${permArgs} --channels plugin:telegram@claude-plugins-official`.replace(/  +/g, ' ').trim()
    const home = state.homedir()
    const dtachSock = join(STATE_DIR, `dtach-${sessionId}.sock`)
    const logFile = join(STATE_DIR, `dtach-${sessionId}.log`)

    // Strip env vars that would confuse the child Claude session
    const cleanEnv = { ...process.env }
    for (const key of Object.keys(cleanEnv)) {
      if (key.startsWith('CLAUDE_') || key.startsWith('MCP_')) {
        delete cleanEnv[key]
      }
    }

    // Pre-accept the workspace trust dialog for the target directory
    try {
        const claudeJsonPath = join(home, '.claude.json')
        const claudeJson = JSON.parse(readFileSync(claudeJsonPath, 'utf8'))
        if (!claudeJson.projects) { claudeJson.projects = {} }
        if (!claudeJson.projects[home]) { claudeJson.projects[home] = {} }
        claudeJson.projects[home].hasTrustDialogAccepted = true
        writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2))
    } catch { /* best-effort — the watchForTrustPrompt fallback will handle it */ }

    // Write pre-assigned session info for the new server to pick up on startup
    writeFileSync(join(STATE_DIR, 'next_session.json'), JSON.stringify({
      id: sessionId,
      title: title || undefined,
      dtachSocket: dtachSock,
    }))

    try {
      // -n = create detached, -E = disable detach char, -z = disable suspend
      execSync(
        `dtach -n "${dtachSock}" -Ez script -q "${logFile}" bash -c 'cd "${home}" && ${claudeCmd}'`,
        { env: cleanEnv, timeout: 5000, encoding: 'utf8' }
      )

      // Watch for trust prompt and auto-accept it
      watchForTrustPrompt(dtachSock, logFile)

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
      await ctx.reply(`Failed to spawn via dtach:\n${detail}`)
    }
    return true
  },
}
