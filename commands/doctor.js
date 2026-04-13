import { join } from 'node:path'
import { $ } from '../imports.js'
// Dynamic import with cache-busting so hot-reload picks up edits to paths.js
const { paths } = await import(`../lib/paths.js#${Math.random()}`)
const { escapeHtml: escHtml } = await import(`../lib/pure/html.js#${Math.random()}`)

export const tips = [
    "/doctor asks Claude to read the server logs + recent Telegram messages and diagnose issues.",
    "Telegram messages are mirrored to ~/.local/share/cbg/state/messages.jsonl for tooling like /doctor.",
]

export const descriptions = {
    doctor: "Ask Claude to diagnose the Telegram channel using logs + message history",
}

const DEFAULT_PROMPT = `You are diagnosing the cbg ("claude_telegram_but_good") Telegram channel.

Two files hold the relevant signal:
  - ${paths.LOG_FILE}        — structured debug log from the standalone server and shims
  - ${paths.MESSAGES_FILE}   — JSONL of every inbound/outbound Telegram message (direction: "in" | "out")

Read the tail of both files (roughly the last ~300 lines of main.log and last ~100 lines of messages.jsonl — more if something looks suspicious). Cross-reference them: for each recent user command, check whether the server actually handled it and whether the reply the user saw matches what the server sent.

Report in this shape, terse:
  1. What the user has been doing in the last few minutes (1-3 bullets).
  2. Anything broken or suspicious — stack traces, failed tool calls, /chat_ lookups that missed, dropped messages, shim disconnects, etc. Quote the relevant log line.
  3. If nothing looks wrong, say "no issues detected" and stop.

Do not speculate about code you have not read. If the evidence is inconclusive, say so.`

async function runClaude(prompt, cwd, state) {
    const cleanEnv = { ...Deno.env.toObject() }
    for (const key of Object.keys(cleanEnv)) {
        if (key.startsWith('CLAUDE_') || key.startsWith('MCP_')) {
            delete cleanEnv[key]
        }
    }
    // --no-tele bypasses the cbg shim wrapper so this invocation doesn't
    // register with the standalone server or spawn a dtach session.
    // dax hard-quotes `${prompt}` so the full prompt text lands as a
    // single argv entry with no shell interpretation.
    try {
        const result = await $`claude --no-tele -p ${prompt}`
            .cwd(cwd)
            .clearEnv()
            .env(cleanEnv)
            .stdin("null")
            .stdout("piped")
            .stderr("piped")
            .timeout(180_000)
            .noThrow()
        return {
            ok: result.code === 0,
            code: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
        }
    } catch (err) {
        state.dbg('DOCTOR', 'spawn error:', err)
        return {
            ok: false,
            stdout: '',
            stderr: `spawn error: ${err instanceof Error ? err.message : String(err)}`,
        }
    }
}

export const commands = {
    doctor: async (ctx, bot, state) => {
        if (ctx.chat?.type !== 'private') return true
        const access = state.loadAccess()
        const senderId = String(ctx.from?.id)
        if (!access.allowFrom.includes(senderId)) return true

        const extra = ctx.message?.text?.replace(/^\/doctor\s*/, '').trim()
        const prompt = extra
            ? `${DEFAULT_PROMPT}\n\nAdditional focus from the user: ${extra}`
            : DEFAULT_PROMPT

        await ctx.reply('Running <i>claude -p</i> to diagnose — this can take up to a minute.', { parse_mode: 'HTML' })

        const result = await runClaude(prompt, paths.STATE_DIR, state)

        const body = (result.stdout || '').trim() || '(no output from claude -p)'
        const header = result.ok ? 'Doctor report:' : `Doctor report (claude -p exited ${result.code}):`

        const MAX = 4096
        const opener = `<b>${escHtml(header)}</b>\n<pre>`
        const closer = '</pre>'
        const budget = MAX - opener.length - closer.length - 10
        let trimmed = body
        if (body.length > budget) {
            trimmed = '...' + body.slice(-(budget - 3))
        }

        try {
            await ctx.reply(`${opener}${escHtml(trimmed)}${closer}`, { parse_mode: 'HTML' })
        } catch (e) {
            state.dbg('DOCTOR', 'HTML send failed, falling back to plain:', e)
            await ctx.reply(`${header}\n${trimmed.slice(-3900)}`)
        }

        if (!result.ok && result.stderr?.trim()) {
            const errTail = result.stderr.trim().slice(-1500)
            try {
                await ctx.reply(`<b>stderr:</b>\n<pre>${escHtml(errTail)}</pre>`, { parse_mode: 'HTML' })
            } catch (e) {
                state.dbg('DOCTOR', 'stderr HTML send failed:', e)
                await ctx.reply(`stderr:\n${errTail}`)
            }
        }

        return true
    },
}
