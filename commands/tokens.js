// commands/tokens.js — how much context a session is carrying, and what
// clearing it would save.
//
// `/tokens` reports this topic's session; `/tokens all` ranks every live
// session so it's obvious which one is worth clearing. The numbers come
// from the backend's contextUsage(), which for Claude reads its transcript
// rather than scraping "N% until auto-compact" off the TUI — see
// lib/pure/context-usage.js.

import { versionedImport } from "../lib/version.js"
const { loadAccess } = await versionedImport("../lib/access.js", import.meta)
const { escapeMarkdown: escMd } = await versionedImport("../lib/pure/markdown.js", import.meta)
const { backendForSession } = await versionedImport("../lib/agent-backends/index.js", import.meta)
const { replyToFromEvent, sendEffect } = await versionedImport("../lib/pure/reply-to.js", import.meta)
const { formatTokens } = await versionedImport("../lib/pure/context-usage.js", import.meta)

export const tips = [
    "/tokens shows how much context this session is carrying, and what /clear would save.",
    "/tokens all ranks every live session by context size — the top one is usually worth clearing.",
]

/** A session line: `AbleOtter 137k/200k (69%) — cbg` */
function sessionLine(session, usage) {
    const label = escMd(session.title || session.id)
    if (!usage.ok) {
        return `• ${label} — ${escMd(usage.detail ?? "unknown")}`
    }
    const bar = usage.percentUsed >= 75 ? "🔴" : usage.percentUsed >= 50 ? "🟡" : "🟢"
    return `${bar} ${label} — *${formatTokens(usage.tokens)}* / ${formatTokens(usage.limit)} (${usage.percentUsed}%)`
}

export const commands = {
    tokens: async (event, core) => {
        const access = loadAccess()
        const isCommandCenter = String(event.chatId) === String(access.commandCenterChatId ?? "")
        if (event.chatType !== "private" && !isCommandCenter) { return { effects: [] } }
        if (!isCommandCenter && !access.allowFrom.includes(String(event.userId ?? ""))) {
            return { effects: [] }
        }

        const replyTo = replyToFromEvent(event, "cmd/tokens")
        const wantsAll = /^\/tokens\s+all\b/i.test(event.text ?? "")
        const sessions = Object.values(core.chatSessions ?? {})

        if (wantsAll) {
            if (sessions.length === 0) {
                return { effects: [sendEffect(replyTo, "No active sessions.")] }
            }
            const rows = []
            for (const session of sessions) {
                const usage = await backendForSession(session).contextUsage({ session })
                rows.push({ session, usage })
            }
            rows.sort((a, b) => (b.usage.tokens ?? -1) - (a.usage.tokens ?? -1))
            const total = rows.reduce((sum, row) => sum + (row.usage.tokens ?? 0), 0)
            const body = rows.map((row) => sessionLine(row.session, row.usage)).join("\n")
            const clearable = rows.filter((row) => row.usage.shouldSuggestClear)
            const footer = clearable.length > 0
                ? `\n\n${clearable.length} session${clearable.length === 1 ? "" : "s"} past 50% — clearing them frees ${formatTokens(clearable.reduce((sum, row) => sum + row.usage.tokens, 0))} tokens per turn.`
                : ""
            return { effects: [sendEffect(replyTo, `*Context per session* (${formatTokens(total)} total)\n\n${body}${footer}`, { format: "markdown" })] }
        }

        // Single-session mode: prefer this topic's binding, else the focused one.
        let session = null
        if (isCommandCenter && event.threadId) {
            const mapped = core.chatState?.commandCenter?.threadMap?.[String(event.threadId)]
            if (mapped) { session = sessions.find((s) => s.id === mapped) }
        }
        if (!session && core.chatState?.focusedSessionId) {
            session = sessions.find((s) => s.id === core.chatState.focusedSessionId)
        }
        if (!session) {
            return { effects: [sendEffect(replyTo, "No session bound to this topic. Try /tokens all.")] }
        }

        const usage = await backendForSession(session).contextUsage({ session })
        if (!usage.ok) {
            return { effects: [sendEffect(replyTo, `Can't read context for "${session.id}": ${usage.detail}`)] }
        }
        const advice = usage.shouldSuggestClear
            ? `\n\nStarting something unrelated? \`/clear\` saves ${formatTokens(usage.tokens)} tokens on every turn from here.`
            : ""
        return {
            effects: [sendEffect(
                replyTo,
                `${sessionLine(session, usage)}\n${formatTokens(usage.remaining)} left${usage.model ? ` · ${escMd(usage.model)}` : ""}${advice}`,
                { format: "markdown" },
            )],
        }
    },
}
