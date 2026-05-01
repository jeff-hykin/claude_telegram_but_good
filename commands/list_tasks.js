// commands/list_tasks.js — Action-returning hot command.
//
// Lists all long tasks (in_progress, defining, cancelled) from
// specialData.longTaskByChatId. Shows title, state, worker session,
// and age for each task.

import { versionedImport } from "../lib/version.js"
const { loadAccess } = await versionedImport("../lib/access.js", import.meta)
const { escapeHtml: esc } = await versionedImport("../lib/pure/html.js", import.meta)
const { replyToFromEvent, sendEffect } = await versionedImport("../lib/pure/reply-to.js", import.meta)

export const tips = [
    "/list_tasks shows all long tasks and their status.",
]

export const descriptions = {
    list_tasks: "Show all long tasks and their current status",
}

function timeAgo(ts) {
    if (!ts) { return null }
    const secs = Math.floor((Date.now() - ts) / 1000)
    if (secs < 60) { return `${secs}s ago` }
    const mins = Math.floor(secs / 60)
    if (mins < 60) { return `${mins}m ago` }
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) { return `${hrs}h ago` }
    const days = Math.floor(hrs / 24)
    return `${days}d ago`
}

const STATE_EMOJI = {
    in_progress: "🔄",
    defining: "📝",
    cancelled: "❌",
    certified: "✅",
}

export const commands = {
    list_tasks: async (event, core) => {
        const access = loadAccess()
        const isCommandCenter = String(event.chatId) === String(access.commandCenterChatId ?? "")
        if (event.chatType !== "private" && !isCommandCenter) { return { effects: [] } }
        if (!isCommandCenter && !access.allowFrom.includes(String(event.userId ?? ""))) {
            return { effects: [] }
        }

        const replyTo = replyToFromEvent(event, "cmd/list_tasks")
        const allTasks = core.specialData?.longTaskByChatId ?? {}

        // Collect tasks from all chats
        const tasks = []
        for (const [_chatId, taskMap] of Object.entries(allTasks)) {
            if (!taskMap || typeof taskMap !== "object") { continue }
            for (const [_taskId, task] of Object.entries(taskMap)) {
                if (!task || typeof task !== "object") { continue }
                tasks.push(task)
            }
        }

        if (tasks.length === 0) {
            return { effects: [sendEffect(replyTo, "No long tasks found.")] }
        }

        // Sort: in_progress first, then defining, then others; within same state by createdAt desc
        const stateOrder = { in_progress: 0, defining: 1, cancelled: 2, certified: 3 }
        tasks.sort((a, b) => {
            const sa = stateOrder[a.state] ?? 99
            const sb = stateOrder[b.state] ?? 99
            if (sa !== sb) { return sa - sb }
            return (b.createdAt ?? "").localeCompare(a.createdAt ?? "")
        })

        const lines = [`<b>Long Tasks</b> (${tasks.length})\n`]

        for (const task of tasks) {
            const emoji = STATE_EMOJI[task.state] ?? "❓"
            const title = (task.title ?? task.id ?? "untitled").slice(0, 50)
            const created = timeAgo(task.createdAt ? new Date(task.createdAt).getTime() : null)
            const worker = task.workerSessionId ?? "none"

            // Check if worker is alive
            const workerSess = core.chatSessions?.[worker]
            const workerAlive = workerSess?._conn ? true : false
            const workerStatus = worker === "none" ? "" : workerAlive ? " (connected)" : " (disconnected)"

            lines.push(`${emoji} <b>${esc(title)}</b>`)
            lines.push(`   ID: <code>${esc(task.id)}</code>`)
            lines.push(`   State: ${esc(task.state)}${created ? ` • Created: ${created}` : ""}`)
            lines.push(`   Worker: ${esc(worker)}${workerStatus}`)
            if (task.state === "in_progress") {
                lines.push(`   /task_status_${esc(task.id)} · /task_cancel_${esc(task.id)}`)
            }
            lines.push("")
        }

        return { effects: [sendEffect(replyTo, lines.join("\n"), { parse_mode: "HTML" })] }
    },
}
