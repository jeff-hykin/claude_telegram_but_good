// commands/connect.js — Action-returning hot command.
//
// Lists sessions not bound to the current topic so the user can
// attach one with /connect_<id>. The actual binding is handled by
// the dynamic /connect_<id> regex in chat-user.js.

import { versionedImport } from "../lib/version.js"
const { loadAccess } = await versionedImport("../lib/access.js", import.meta)
const { escapeHtml: esc } = await versionedImport("../lib/pure/html.js", import.meta)
const { replyToFromEvent, sendEffect } = await versionedImport("../lib/pure/reply-to.js", import.meta)

export const tips = []

export const descriptions = {
    connect: "Attach a shell-started session to this topic",
}

function timeAgo(ts) {
    if (!ts) { return null }
    const secs = Math.floor((Date.now() - ts) / 1000)
    if (secs < 60) { return `${secs}s ago` }
    const mins = Math.floor(secs / 60)
    if (mins < 60) { return `${mins}m ago` }
    const hrs = Math.floor(mins / 60)
    return `${hrs}h ago`
}

export const commands = {
    connect: (event, core) => {
        const access = loadAccess()
        const isCommandCenter = String(event.chatId) === String(access.commandCenterChatId ?? "")
        if (event.chatType !== "private" && !isCommandCenter) {
            return { effects: [] }
        }

        const replyTo = replyToFromEvent(event, "cmd/connect")
        const cc = core.chatState?.commandCenter ?? {}
        const currentThreadId = event.threadId ? String(event.threadId) : null

        // Find the session currently bound to this topic (if any)
        const boundSessionId = currentThreadId ? (cc.threadMap?.[currentThreadId] ?? null) : null

        // Collect connected sessions not bound to this topic
        const candidates = []
        for (const [sid, s] of Object.entries(core.chatSessions ?? {})) {
            if (!s?._conn) { continue }
            if (sid === boundSessionId) { continue }
            const threadId = cc.topicMap?.[sid] ?? null
            const topicName = threadId ? (cc.topicNames?.[threadId] ?? null) : null
            candidates.push({
                id: sid,
                title: s.title ?? null,
                cwd: s.cwd ?? null,
                gitBranch: s.gitBranch ?? null,
                topicName,
                lastActive: s.lastActive ?? null,
            })
        }

        // Sort by most recently active
        candidates.sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))

        if (candidates.length === 0) {
            return {
                effects: [sendEffect(replyTo,
                    "No available sessions to connect. Start a claude session in a terminal first.",
                    { parse_mode: "HTML" },
                )],
            }
        }

        const home = Deno.env.get("HOME") ?? ""
        const shortPath = (p) => {
            if (!p) { return "" }
            return p.startsWith(home) ? "~" + p.slice(home.length) : p
        }

        const lines = ["<b>Available sessions:</b>\n"]
        for (const s of candidates) {
            const title = s.title || s.id
            const active = timeAgo(s.lastActive)
            const bound = s.topicName ? ` [${esc(s.topicName)}]` : ""
            lines.push(`<b>${esc(title)}</b>${bound}`)
            if (s.cwd) {
                lines.push(`  <code>${esc(shortPath(s.cwd))}</code>${s.gitBranch ? ` @ <code>${esc(s.gitBranch)}</code>` : ""}`)
            }
            if (active) {
                lines.push(`  active: ${active}`)
            }
            lines.push(`  /connect_${esc(s.id)}`)
            lines.push("")
        }

        return {
            effects: [sendEffect(replyTo, lines.join("\n"), { parse_mode: "HTML" })],
        }
    },
}
