// ---------------------------------------------------------------------------
// lib/effects/shell-command.js — `#`/`!`-prefix shell commands.
//
// Triggered by chat-user.js when an inbound message starts with `#` or `!`.
// Spawns `zsh -c <cmd>` with the topic's persisted cwd, captures
// stdout+stderr, and replies as text (≤3500 chars) or attaches a file.
//
// Active processes are tracked in `core.activeShellProcs` keyed by
// `<chatId>:<threadId|''>` so commands/cancel.js can SIGTERM the
// running command when /cancel arrives in the same topic.
//
// `# cd <path>` (or `! cd …`) is handled INLINE in chat-user.js (no
// fork) — this effect only handles command execution.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { escapeMarkdown } = await versionedImport("../pure/markdown.js", import.meta)
const telegramOutbound = await versionedImport("./telegram-outbound.js", import.meta)

const INLINE_LIMIT = 3500
const MAX_RUNTIME_MS = 30 * 60 * 1000

export function topicShellKey(chatId, threadId) {
    const t = threadId == null || threadId === "" ? "" : String(threadId)
    return `${String(chatId)}:${t}`
}

function formatInline(cmd, cwd, code, signal, stdout, stderr, cancelled) {
    const header = cancelled
        ? `*$ ${escapeMarkdown(cmd)}*  _[cancelled${signal ? ` ${signal}` : ""}]_`
        : `*$ ${escapeMarkdown(cmd)}*${code !== 0 ? ` _(exit ${code}${signal ? ` ${signal}` : ""})_` : ""}`
    const parts = [header, `_cwd:_ \`${cwd}\``]
    if (stdout && stdout.length > 0) {
        parts.push("```\n" + stdout + "\n```")
    }
    if (stderr && stderr.length > 0) {
        parts.push("_stderr:_\n```\n" + stderr + "\n```")
    }
    if ((!stdout || stdout.length === 0) && (!stderr || stderr.length === 0)) {
        parts.push("_(no output)_")
    }
    return parts.join("\n")
}

function formatFileBody(cmd, cwd, code, signal, stdout, stderr, cancelled) {
    const lines = [
        `$ ${cmd}`,
        `cwd: ${cwd}`,
        cancelled
            ? `cancelled${signal ? ` (${signal})` : ""}`
            : `exit: ${code}${signal ? ` (${signal})` : ""}`,
        "",
        "--- stdout ---",
        stdout || "(empty)",
        "",
        "--- stderr ---",
        stderr || "(empty)",
    ]
    return lines.join("\n")
}

/**
 * Effect shape: {
 *   type: "shell_command_spawn",
 *   key: string,                           // topic key from topicShellKey
 *   chatId: string,
 *   threadId: number|null,
 *   cmd: string,                           // raw command line for `zsh -c`
 *   cwd: string,                           // resolved absolute cwd
 *   replyTo: { chatId, threadId, setBy },  // where to deliver result
 * }
 */
export async function spawnShellCommand(effect, core) {
    const { key, cmd, cwd, replyTo, chatId, threadId } = effect
    if (!core.activeShellProcs) { core.activeShellProcs = new Map() }

    if (core.activeShellProcs.has(key)) {
        const existing = core.activeShellProcs.get(key)
        await telegramOutbound.sendTextMessageToUser({
            type: "send_text_to_user",
            replyTo,
            text: `Already running: \`${escapeMarkdown(existing.cmd)}\`. Use /cancel to abort.`,
            options: { parse_mode: "Markdown" },
        }, core)
        return
    }

    let proc
    try {
        const command = new Deno.Command("zsh", {
            args: ["-c", cmd],
            cwd,
            stdout: "piped",
            stderr: "piped",
            stdin: "null",
            env: { ...Deno.env.toObject(), CBG_TOPIC_SHELL: "1" },
        })
        proc = command.spawn()
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        dbg("SHELL", `spawn failed for ${key}:`, msg)
        await telegramOutbound.sendTextMessageToUser({
            type: "send_text_to_user",
            replyTo,
            text: `Spawn failed: ${escapeMarkdown(msg)}`,
            options: { parse_mode: "Markdown" },
        }, core)
        return
    }

    const entry = {
        proc, cmd, cwd, chatId, threadId, replyTo,
        startedAt: Date.now(),
        cancelled: false,
        timeoutId: null,
    }
    core.activeShellProcs.set(key, entry)
    dbg("SHELL", `[${key}] pid=${proc.pid} spawned: ${cmd}`)

    entry.timeoutId = setTimeout(() => {
        if (core.activeShellProcs.get(key) === entry) {
            entry.cancelled = true
            try { proc.kill("SIGTERM") } catch (_) {}
            dbg("SHELL", `[${key}] timeout — sent SIGTERM`)
        }
    }, MAX_RUNTIME_MS)

    // Fire and forget; the await chain delivers the reply when done.
    ;(async () => {
        let stdout = ""
        let stderr = ""
        let code = -1
        let signal = null
        try {
            const [out, err, status] = await Promise.all([
                proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
                proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
                proc.status,
            ])
            stdout = out
            stderr = err
            code = status.code
            signal = status.signal ?? null
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            dbg("SHELL", `[${key}] read failed:`, msg)
            stderr = (stderr ? stderr + "\n" : "") + `[shell-effect: ${msg}]`
        } finally {
            if (entry.timeoutId) { clearTimeout(entry.timeoutId) }
            if (core.activeShellProcs.get(key) === entry) {
                core.activeShellProcs.delete(key)
            }
        }

        const cancelled = entry.cancelled
        const inlineText = formatInline(cmd, cwd, code, signal, stdout, stderr, cancelled)
        if (inlineText.length <= INLINE_LIMIT) {
            await telegramOutbound.sendTextMessageToUser({
                type: "send_text_to_user",
                replyTo,
                text: inlineText,
                options: { parse_mode: "Markdown" },
            }, core)
            return
        }

        // Long output — write to temp file, attach
        const ts = new Date().toISOString().replace(/[:.]/g, "-")
        const safeKey = key.replace(/[^A-Za-z0-9_-]/g, "_")
        const filePath = `/tmp/cbg-shell-${safeKey}-${ts}.txt`
        const body = formatFileBody(cmd, cwd, code, signal, stdout, stderr, cancelled)
        try {
            await Deno.writeTextFile(filePath, body)
        } catch (e) {
            dbg("SHELL", `[${key}] writeTextFile failed:`, e instanceof Error ? e.message : String(e))
            await telegramOutbound.sendTextMessageToUser({
                type: "send_text_to_user",
                replyTo,
                text: `Output too large (${body.length} chars) and could not stage to ${escapeMarkdown(filePath)}: ${escapeMarkdown(e instanceof Error ? e.message : String(e))}`,
                options: { parse_mode: "Markdown" },
            }, core)
            return
        }
        const summary = formatInline(cmd, cwd, code, signal, "(see attached)", "", cancelled)
        const truncatedSummary = summary.length <= INLINE_LIMIT ? summary : summary.slice(0, INLINE_LIMIT)
        await telegramOutbound.sendFileToUser({
            type: "send_file_to_user",
            replyTo,
            filePath,
            filename: "output.txt",
            caption: truncatedSummary,
            options: {},
        }, core)
    })()
}
