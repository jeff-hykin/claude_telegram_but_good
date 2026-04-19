// commands/cron.js — Action-returning hot command.
//
// Reads $HOME/.claude/scheduled-tasks/* from the filesystem. The read
// stays inline; it's bounded and has no state side effects.

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { versionedImport } from "../lib/version.js"
const { loadAccess } = await versionedImport("../lib/access.js", import.meta)
const { escapeHtml: esc } = await versionedImport("../lib/pure/html.js", import.meta)
const { makeReplyTo, sendEffect } = await versionedImport("../lib/pure/reply-to.js", import.meta)

export const tips = [
    "/cron shows all scheduled tasks — set them up with the /schedule skill. JK! I haven't finished this feature yet",
]

function readScheduledTasks(homeDir) {
    const tasksDir = join(homeDir, ".claude", "scheduled-tasks")
    const tasks = []
    let dirs
    try {
        dirs = readdirSync(tasksDir, { withFileTypes: true })
    } catch (e) {
        return tasks
    }

    for (const entry of dirs) {
        if (!entry.isDirectory()) { continue }
        const skillFile = join(tasksDir, entry.name, "SKILL.md")
        try {
            const content = readFileSync(skillFile, "utf8")
            const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
            let name = entry.name
            let description = ""
            let prompt = content

            if (fmMatch) {
                const fm = fmMatch[1]
                prompt = fmMatch[2].trim()
                const nameMatch = fm.match(/^name:\s*(.+)$/m)
                const descMatch = fm.match(/^description:\s*(.+)$/m)
                if (nameMatch) { name = nameMatch[1].trim() }
                if (descMatch) { description = descMatch[1].trim() }
            }

            tasks.push({ name, description, prompt: prompt.slice(0, 100), dir: entry.name })
        } catch (e) {
            // Best effort per entry — a malformed SKILL.md shouldn't hide the rest.
        }
    }
    return tasks
}

export const descriptions = {
    cron: "List scheduled tasks",
    schedule: "Create or manage a scheduled task",
}

export const commands = {
    cron: (event, _core) => {
        if (event.chatType !== "private") {
            return { effects: [] }
        }
        const access = loadAccess()
        const senderId = String(event.userId ?? "")
        if (!access.allowFrom.includes(senderId)) {
            return { effects: [] }
        }

        const replyTo = makeReplyTo(event, "cmd/cron")
        const home = Deno.env.get("HOME") ?? ""
        const parts = []

        const tasks = readScheduledTasks(home)
        if (tasks.length > 0) {
            parts.push(`<b>Scheduled Tasks</b> (${tasks.length})`)
            parts.push("")
            for (const t of tasks) {
                let line = `📋 <b>${esc(t.name)}</b>`
                if (t.description) { line += `\n   ${esc(t.description)}` }
                if (t.prompt) { line += `\n   <i>${esc(t.prompt)}${t.prompt.length >= 100 ? "..." : ""}</i>` }
                parts.push(line)
            }
        } else {
            parts.push("<b>Scheduled Tasks</b>")
            parts.push("No desktop scheduled tasks found.")
        }

        // CBG-managed scheduled tasks (from specialData.scheduledTaskByChatId)
        const byChat = _core?.specialData?.scheduledTaskByChatId ?? {}
        const cbgTasks = []
        for (const [chatId, tasks] of Object.entries(byChat)) {
            for (const [id, task] of Object.entries(tasks ?? {})) {
                cbgTasks.push({ chatId, id, task })
            }
        }
        if (cbgTasks.length > 0) {
            parts.push("")
            parts.push(`<b>CBG Scheduled Tasks</b> (${cbgTasks.length})`)
            parts.push("")
            for (const { id, task } of cbgTasks) {
                parts.push(`⏰ <code>${esc(id)}</code> — ${esc(task.title ?? "")}`)
                parts.push(`   state=${esc(task.state ?? "?")} next=${esc(task.tracking?.nextFireAt ?? "?")}`)
                parts.push(`   /schedule_status_${esc(id)}   /schedule_cancel_${esc(id)}`)
            }
        }

        parts.push("")
        parts.push("<b>Session Cron Jobs (/loop)</b>")
        parts.push("Session cron jobs are in-memory only and cannot be listed externally.")
        parts.push("Use /loop inside a Claude Code session to manage them.")

        return {
            effects: [sendEffect(replyTo, parts.join("\n"), { parse_mode: "HTML" })],
        }
    },
}
