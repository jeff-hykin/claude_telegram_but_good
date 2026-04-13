import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { $ } from '../imports.js'
// Dynamic import with cache-busting so hot-reload picks up edits.
const { paths } = await import(`../lib/paths.js#${Math.random()}`)
const { generateName } = await import(`../lib/pure/ids.js#${Math.random()}`)

/**
 * After dtach spawns Claude, poll the log file for the "trust this folder"
 * prompt. If detected, send Enter to accept it.
 */
function watchForTrustPrompt(dtachSock, logFile, maxWaitMs = 15000) {
    const start = Date.now()
    const poll = async () => {
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
                // Send Enter (\n) via dtach -p. dax interpolates the
                // socket path as a single properly-quoted arg.
                try {
                    await $`dtach -p ${dtachSock}`.stdinText("\n").timeout(3000)
                } catch { /* ignore */ }
                return
            }
        } catch { /* file not ready yet */ }
        setTimeout(poll, 500)
    }
    setTimeout(poll, 1000)
}

export const tips = [
    "/new &lt;name&gt; gives your session a title so it's easy to find later.",
    "Sessions launched with /new run headless — use /peek to see what they're doing.",
    "New sessions can be re-attached from the terminal with <code>cbg resume</code> when you're back at your computer.",
]

export const descriptions = {
  new: "Launch a new Claude Code session",
}

export const commands = {
  new: async (ctx, bot, state) => {
    if (ctx.chat?.type !== 'private') return true
    const access = state.loadAccess()
    const senderId = String(ctx.from?.id)
    if (!access.allowFrom.includes(senderId)) return true

    // Check for dtach
    if (!(await $.commandExists("dtach"))) {
      await ctx.reply('dtach not found. Install it with: brew install dtach / apt-get install dtach / nix profile install nixpkgs#dtach')
      return true
    }

    // Pre-assign the session ID so we know the switch command ahead of time.
    // Using generateName directly rather than state.generateName because
    // buildHotCommandState doesn't expose the latter — this is the one
    // hot command that needs fresh session ids.
    const sessionId = generateName()
    const title = ctx.message?.text?.replace(/^\/new\s*/, '').trim() || undefined

    // Read permission args from config file
    let permArgs = ''
    try {
        permArgs = readFileSync(paths.PERMISSION_ARGS_FILE, 'utf8').trim()
    } catch {
        // no permission config — use defaults
    }
    // `--no-tele` is the first arg so the cbg shim wrapper at
    // ~/.local/bin/claude execs the real binary directly. Without it the
    // wrapper would re-wrap us in another dtach session AND overwrite
    // next_session.json — stripping the pre-assigned session id.
    const claudeCmd = `claude --no-tele ${permArgs} --channels plugin:telegram@claude-plugins-official`.replace(/  +/g, ' ').trim()
    const home = state.homedir()
    const dtachSock = paths.dtachSockFile(sessionId)
    const logFile = paths.dtachLogFile(sessionId)

    // Strip env vars that would confuse the child Claude session
    const cleanEnv = { ...Deno.env.toObject() }
    for (const key of Object.keys(cleanEnv)) {
      if (key.startsWith('CLAUDE_') || key.startsWith('MCP_')) {
        delete cleanEnv[key]
      }
    }
    // Force /bin/bash so script -c doesn't run our command through the user's
    // login shell. zsh users with interactive prompts in .zshrc (e.g. Gas
    // Town's "Add to Gas Town?" prompt) would block forever waiting for input.
    cleanEnv.SHELL = '/bin/bash'

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
    writeFileSync(paths.NEXT_SESSION_FILE, JSON.stringify({
      id: sessionId,
      title: title || undefined,
      dtachSocket: dtachSock,
    }))

    try {
      // -n = create detached, -E = disable detach char, -z = disable suspend.
      // `script` syntax differs by platform: macOS/BSD takes the logfile as a
      // positional arg followed by the command; util-linux requires -c "cmd"
      // with the logfile last. Mixing them silently fails — dtach -n still
      // exits 0 because the fork succeeded.
      // -f flushes after each write so watchForTrustPrompt can see output
      // live; without it the log only appears when script exits.
      //
      // dax interpolation quotes each ${arg} as a single shell argument, so
      // `${inner}` lands as one arg to `bash -c` (or `script -c`) with no
      // extra escaping needed — this is the main win over execSync, which
      // required manually quoting the socket path, log path, etc.
      const inner = `cd "${home}" && ${claudeCmd}`
      const isDarwin = Deno.build.os === 'darwin'
      const cmd = isDarwin
        ? $`dtach -n ${dtachSock} -Ez script -q -F ${logFile} bash -c ${inner}`
        : $`dtach -n ${dtachSock} -Ez script -fq -c ${inner} ${logFile}`
      await cmd
        .clearEnv()
        .env(cleanEnv)
        .timeout(5000)
        .stdout("piped")
        .stderr("piped")

      // Watch for trust prompt and auto-accept it
      watchForTrustPrompt(dtachSock, logFile)

      const displayTitle = title ? ` (${title})` : ''
      await ctx.reply(`Created: /chat_${sessionId}${displayTitle}`)

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
      state.dbg('NEW', 'failed:', detail)
      await ctx.reply(`Failed to create new session via dtach:\n${detail}`)
    }
    return true
  },
}
