// commands/list.js — Action-returning hot command.
//
// Reads core.chatSessions to format a per-session summary. Pure: no
// state mutation, no external I/O.

import { versionedImport } from "../lib/version.js"
const { loadAccess } = await versionedImport("../lib/access.js", import.meta)
const { escapeHtml: esc } = await versionedImport("../lib/pure/html.js", import.meta)

export const tips = [
    "Tap a session ID from /list to switch to it.",
    "Replying to a message that has /chat_&lt;id&gt; at the top will always send the response to that chat (even if its not your currently-active session)",
]

function timeAgo(ts) {
    if (!ts) {
        return null
    }
    const secs = Math.floor((Date.now() - ts) / 1000)
    if (secs < 60) {
        return `${secs}s ago`
    }
    const mins = Math.floor(secs / 60)
    if (mins < 60) {
        return `${mins}m ago`
    }
    const hrs = Math.floor(mins / 60)
    return `${hrs}h ago`
}

function sessionBlock(s, { shortPath, isActive }) {
    const lines = []

    const title = s.title || s.id
    const marker = isActive ? " [active]" : ""
    lines.push(`<b>${esc(title)}</b>${marker}`)

    const active = timeAgo(s.lastActive)
    if (active) {
        lines.push(`  \u2022 \u26A1 active: ${esc(active)}`)
    }
    if (s.connectedAt) {
        lines.push(`  \u2022 \uD83D\uDD52 started: ${esc(timeAgo(s.connectedAt))}`)
    }
    if (s.gitBranch) {
        lines.push(`  \u2022 \uD83C\uDF3F branch: <code>${esc(s.gitBranch)}</code>`)
    }
    const sp = shortPath(s.cwd)
    if (sp === "~") {
        lines.push(`  \u2022 \uD83D\uDCC2 dir: <code>(home dir)</code>`)
    } else {
        lines.push(`  \u2022 \uD83D\uDCC2 dir: <code>${esc(sp)}</code>`)
    }
    if (s.recentMessages && s.recentMessages.length > 0) {
        for (const msg of s.recentMessages) {
            const icon = msg.role === "bot" ? "\uD83E\uDD16" : "\uD83D\uDDE3"
            lines.push(`  ${icon} <i>${esc(msg.text.replace(/\n+/g, " "))}</i>`)
        }
    }

    lines.push(`  \u2022 /chat_${esc(s.id)}`)
    return lines.join("\n")
}

export const descriptions = {
    list: "Show connected Claude Code sessions",
}

function reply(chatId, text, options = { parse_mode: "HTML" }) {
    return {
        effects: [{ type: "send_text_to_user", chatId, text, options }],
    }
}

export const commands = {
    list: (event, core) => {
        if (event.chatType !== "private") {
            return { effects: [] }
        }
        const access = loadAccess()
        const senderId = String(event.userId ?? "")
        if (!access.allowFrom.includes(senderId)) {
            return { effects: [] }
        }

        const sessions = Object.values(core.chatSessions ?? {}).map(s => ({
            id: s.id,
            pid: s.pid,
            cwd: s.cwd,
            title: s.title ?? null,
            gitBranch: s.gitBranch ?? null,
            dtachSocket: s.dtachSocket,
            connectedAt: s.connectedAt,
            lastActive: s.lastActive ?? null,
            recentMessages: s.recentMessages ?? [],
        }))

        if (sessions.length === 0) {
            return reply(event.chatId, "No sessions connected. Use /new/new to make one from here", {})
        }

        const home = Deno.env.get("HOME") ?? ""
        const shortPath = (p) => {
            if (!p) { return "" }
            return p.startsWith(home) ? "~" + p.slice(home.length) : p
        }

        const focusedId = core.chatState?.focusedSessionId
        const active = sessions.find(s => s.id === focusedId)
        const others = sessions.filter(s => s.id !== focusedId)

        const parts = []
        if (active) {
            parts.push(sessionBlock(active, { shortPath, isActive: true }))
        }
        for (const s of others) {
            parts.push(sessionBlock(s, { shortPath, isActive: false }))
        }

        return reply(event.chatId, parts.join("\n\n"))
    },
}
