// commands/status.js — Action-returning hot command.
//
// Reads the access file + shells out to `ps aux` to list live Claude
// Code processes. The subprocess call stays inline (it's bounded, 5 s
// timeout) rather than being lifted into an effect type, since it has
// no other callers and no state implications.
//
// ── Why `format: "plain"` ──
//
// This command echoes raw `ps aux` output. A single long-running
// Claude child's command line can contain `<`, `>`, `|`, `&`, `2>`
// (shell redirects), unpaired quotes, backticks, and any other
// character the shell tolerates. The `send_text_to_user` effect's
// default format is `"html"` (per CLAUDE.md's "Telegram messages
// default to HTML" rule), which routes the text through Telegram's
// HTML parser — and that parser rejects the whole message with
// "Bad Request: can't parse entities" the moment it sees an
// unopened tag like `>` or `2>`. The send then fails silently and
// the user sees NOTHING.
//
// Explicitly passing `format: "plain"` bypasses the parser. We don't
// need any HTML features here — `/status` is a diagnostic dump, not
// a formatted message — so plain is correct regardless.

import { $ } from "../imports.js"
import { versionedImport } from "../lib/version.js"
const { loadAccess } = await versionedImport("../lib/access.js", import.meta)
const { replyToFromEvent } = await versionedImport("../lib/pure/reply-to.js", import.meta)

export const tips = []

export const descriptions = {
    status: "Check your pairing status",
}

async function listClaudeSessions() {
    try {
        const lines = await $`ps aux`.timeout(5000).lines()
        const sessions = []
        for (const line of lines) {
            if (
                (/\bclaude\b/i.test(line)) &&
                !line.includes("telegram") &&
                !line.includes("ps aux") &&
                !line.includes("grep")
            ) {
                const cols = line.trim().split(/\s+/)
                const pid = cols[1]
                const cmd = cols.slice(10).join(" ")
                if (pid && cmd) {
                    sessions.push(`PID ${pid}: ${cmd}`)
                }
            }
        }
        return sessions
    } catch (e) {
        // Best-effort: a missing `ps` shouldn't crash /status.
        return []
    }
}

export const commands = {
    status: async (event, _core) => {
        if (!event.userId) {
            return { effects: [] }
        }
        const access = loadAccess()
        const isCommandCenter = String(event.chatId) === String(access.commandCenterChatId ?? "")
        if (event.chatType !== "private" && !isCommandCenter) {
            return { effects: [] }
        }
        const senderId = String(event.userId)
        const parts = []

        if (access.allowFrom.includes(senderId)) {
            const name = event.username ? `@${event.username}` : senderId
            parts.push(`Paired as ${name}.`)
        } else {
            let found = false
            for (const [code, p] of Object.entries(access.pending ?? {})) {
                if (p.senderId === senderId) {
                    parts.push(`Pending pairing — run in Claude Code:\n/telegram:access pair ${code}`)
                    found = true
                    break
                }
            }
            if (!found) {
                parts.push(`Not paired. Send me a message to get a pairing code.`)
            }
        }

        const procs = await listClaudeSessions()
        if (procs.length > 0) {
            parts.push(`\nRunning Claude Code processes (${procs.length}):`)
            for (const s of procs) {
                parts.push(s)
            }
        } else {
            parts.push(`\nNo Claude Code processes detected.`)
        }

        const replyTo = event._replyTo ?? replyToFromEvent(event, "cmd:status")
        return {
            effects: [
                {
                    type: "send_text_to_user",
                    replyTo,
                    text: parts.join("\n"),
                    options: { format: "plain" },
                },
            ],
        }
    },
}
