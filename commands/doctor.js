// commands/doctor.js — Action-returning hot command.
//
// Spawns `claude -p` with a diagnostic prompt. The subprocess stays
// inline (bounded 180 s timeout) — there's no effect-layer helper for
// one-shot claude -p calls yet, and /doctor is the only caller.

import { $ } from "../imports.js"
import { versionedImport } from "../lib/version.js"
const { loadAccess } = await versionedImport("../lib/access.js", import.meta)
const { dbg } = await versionedImport("../lib/logging.js", import.meta)
const { paths } = await versionedImport("../lib/paths.js", import.meta)
const { escapeHtml: escHtml } = await versionedImport("../lib/pure/html.js", import.meta)
const { sendEffect } = await versionedImport("../lib/pure/reply-to.js", import.meta)

export const tips = [
    "/doctor asks Claude to read the server logs + recent Telegram messages and diagnose issues.",
    "Telegram messages are mirrored to ~/.local/share/cbg/state/messages.jsonl for tooling like /doctor.",
]

export const descriptions = {
    doctor: "Ask Claude to diagnose the Telegram channel using logs + message history",
}

function buildDefaultPrompt() {
    return `You are diagnosing the cbg ("claude_telegram_but_good") Telegram channel.

Two files hold the relevant signal:
  - ${paths.LOG_FILE}        — structured debug log from the standalone server and shims
  - ${paths.MESSAGES_FILE}   — JSONL of every inbound/outbound Telegram message (direction: "in" | "out")

Read the tail of both files (roughly the last ~300 lines of main.log and last ~100 lines of messages.jsonl — more if something looks suspicious). Cross-reference them: for each recent user command, check whether the server actually handled it and whether the reply the user saw matches what the server sent.

Report in this shape, terse:
  1. What the user has been doing in the last few minutes (1-3 bullets).
  2. Anything broken or suspicious — stack traces, failed tool calls, /chat_ lookups that missed, dropped messages, shim disconnects, etc. Quote the relevant log line.
  3. If nothing looks wrong, say "no issues detected" and stop.

Do not speculate about code you have not read. If the evidence is inconclusive, say so.`
}

async function runClaude(prompt, cwd) {
    const cleanEnv = { ...Deno.env.toObject() }
    for (const key of Object.keys(cleanEnv)) {
        if (key.startsWith("CLAUDE_") || key.startsWith("MCP_")) {
            delete cleanEnv[key]
        }
    }
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
        dbg("DOCTOR", "spawn error:", err)
        return {
            ok: false,
            stdout: "",
            stderr: `spawn error: ${err instanceof Error ? err.message : String(err)}`,
        }
    }
}

export const commands = {
    doctor: async (event, _core) => {
        const access = loadAccess()
        const isCC = String(event.chatId) === String(access.commandCenterChatId ?? "")
        if (event.chatType !== "private" && !isCC) { return { effects: [] } }
        if (!access.allowFrom.includes(String(event.userId ?? ""))) {
            return { effects: [] }
        }

        const extra = (event.text ?? "").replace(/^\/doctor\s*/, "").trim()
        const prompt = extra
            ? `${buildDefaultPrompt()}\n\nAdditional focus from the user: ${extra}`
            : buildDefaultPrompt()

        const effects = [
            sendEffect(event.replyTo, "Running <i>claude -p</i> to diagnose — this can take up to a minute.", { parse_mode: "HTML" }),
        ]

        const result = await runClaude(prompt, paths.STATE_DIR)

        const body = (result.stdout || "").trim() || "(no output from claude -p)"
        const header = result.ok ? "Doctor report:" : `Doctor report (claude -p exited ${result.code}):`

        const MAX = 4096
        const opener = `<b>${escHtml(header)}</b>\n<pre>`
        const closer = "</pre>"
        const budget = MAX - opener.length - closer.length - 10
        let trimmed = body
        if (body.length > budget) {
            trimmed = "..." + body.slice(-(budget - 3))
        }

        effects.push(sendEffect(event.replyTo, `${opener}${escHtml(trimmed)}${closer}`, { parse_mode: "HTML" }))

        if (!result.ok && result.stderr?.trim()) {
            const errTail = result.stderr.trim().slice(-1500)
            effects.push(sendEffect(event.replyTo, `<b>stderr:</b>\n<pre>${escHtml(errTail)}</pre>`, { parse_mode: "HTML" }))
        }

        return { effects }
    },
}
