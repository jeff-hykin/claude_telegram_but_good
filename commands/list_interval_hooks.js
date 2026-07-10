// commands/list_interval_hooks.js — Action-returning hot command.
//
// Lists all interval hooks from specialData.intervalHookByChatId. Shows
// title, topic, active state, run count, and last-run status for each.
// Mirrors commands/list_tasks.js.

import { versionedImport } from "../lib/version.js"
const { loadAccess } = await versionedImport("../lib/access.js", import.meta)
const { replyToFromEvent, sendEffect } = await versionedImport("../lib/pure/reply-to.js", import.meta)
const { intervalHookCommandLinks } = await versionedImport("../lib/interval-hook-actions.js", import.meta)

export const descriptions = {
    interval_hooks: "Show all interval hooks and their status",
}

function timeAgo(ts) {
    if (!ts) { return null }
    const secs = Math.floor((Date.now() - ts) / 1000)
    if (secs < 60) { return `${secs}s ago` }
    const mins = Math.floor(secs / 60)
    if (mins < 60) { return `${mins}m ago` }
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) { return `${hrs}h ago` }
    return `${Math.floor(hrs / 24)}d ago`
}

export const commands = {
    interval_hooks: async (event, core) => {
        const access = loadAccess()
        const isCommandCenter = String(event.chatId) === String(access.commandCenterChatId ?? "")
        if (event.chatType !== "private" && !isCommandCenter) { return { effects: [] } }
        if (!isCommandCenter && !access.allowFrom.includes(String(event.userId ?? ""))) {
            return { effects: [] }
        }

        const replyTo = replyToFromEvent(event, "cmd/interval_hooks")
        const byChat = core.specialData?.intervalHookByChatId ?? {}

        const hooks = []
        for (const hookMap of Object.values(byChat)) {
            if (!hookMap || typeof hookMap !== "object") { continue }
            for (const hook of Object.values(hookMap)) {
                if (hook && typeof hook === "object") { hooks.push(hook) }
            }
        }

        if (hooks.length === 0) {
            return { effects: [sendEffect(replyTo, "No interval hooks found.")] }
        }

        // Active first, then by createdAt desc.
        hooks.sort((a, b) => {
            if (!!a.active !== !!b.active) { return a.active ? -1 : 1 }
            return (b.createdAt ?? "").localeCompare(a.createdAt ?? "")
        })

        const lines = [`*Interval Hooks* (${hooks.length})\n`]
        for (const hook of hooks) {
            const emoji = hook.active ? "🟢" : "⚪️"
            const created = timeAgo(hook.createdAt ? new Date(hook.createdAt).getTime() : null)
            const tr = hook.tracking ?? {}
            lines.push(`${emoji} ${(hook.title ?? hook.id).slice(0, 50)}`)
            lines.push(`   ID: ${hook.id} → topic: ${hook.topic}`)
            lines.push(`   ${hook.active ? "active" : "inactive"} • runs: ${tr.totalRuns ?? 0}${tr.lastRunStatus ? ` • last: ${tr.lastRunStatus}` : ""}${created ? ` • created ${created}` : ""}`)
            lines.push(`   ${intervalHookCommandLinks(hook.id).replace("\n", " · ")}`)
            lines.push("")
        }

        return { effects: [sendEffect(replyTo, lines.join("\n"), {})] }
    },
}
