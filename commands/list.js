// commands/list.js — Action-returning hot command.
//
// Reads core.chatSessions to format a per-session summary. Pure: no
// state mutation, no external I/O.

import { versionedImport } from "../lib/version.js"
const { loadAccess } = await versionedImport("../lib/access.js", import.meta)
const { escapeHtml: esc } = await versionedImport("../lib/pure/html.js", import.meta)
const { replyToFromEvent } = await versionedImport("../lib/pure/reply-to.js", import.meta)

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
    // A session that's in chatSessions but has no live `_conn` is
    // "zombie metadata" — it exists in the registry because the daemon
    // persisted it across a restart (or because the shim exited without
    // the unregister frame firing), but the underlying Claude process
    // is gone or unreachable. Users can't message it.
    let marker = ""
    if (!s.hasConn) {
        marker = " [disconnected]"
    } else if (isActive) {
        marker = " [active]"
    }
    lines.push(`<b>${esc(title)}</b>${marker}`)

    // /chat_<id> sits directly under the title so it's the first thing
    // you can tap for a reachable session. A disconnected session can't
    // be messaged, so we surface its stale-metadata hint instead.
    if (s.hasConn) {
        lines.push(`  • /chat_${esc(s.id)}`)
    } else {
        lines.push(`  • <i>(gone — start a new one with /new)</i>`)
    }

    const active = timeAgo(s.lastActive)
    if (active) {
        lines.push(`  • ⚡ active: ${esc(active)}`)
    }
    if (s.connectedAt) {
        lines.push(`  • 🕒 started: ${esc(timeAgo(s.connectedAt))}`)
    }
    if (s.gitBranch) {
        lines.push(`  • 🌿 branch: <code>${esc(s.gitBranch)}</code>`)
    }
    const sp = shortPath(s.cwd)
    if (sp === "~") {
        lines.push(`  • 📂 dir: <code>(home dir)</code>`)
    } else {
        lines.push(`  • 📂 dir: <code>${esc(sp)}</code>`)
    }
    if (s.recentMessages && s.recentMessages.length > 0) {
        for (const msg of s.recentMessages) {
            const icon = msg.role === "bot" ? "🤖" : "🗣"
            lines.push(`  ${icon} <i>${esc(msg.text.replace(/\n+/g, " "))}</i>`)
        }
    }

    // /close_<id> sits at the bottom of the block so it's the last
    // item in each session's section. Graceful close only makes sense
    // for a session that's actually connected.
    if (s.hasConn) {
        lines.push(`  • /close_${esc(s.id)}`)
    }
    return lines.join("\n")
}

export const descriptions = {
    list: "Show connected Claude Code sessions",
}

function reply(replyTo, text, options = { parse_mode: "HTML" }) {
    return {
        effects: [{ type: "send_text_to_user", replyTo, text, options }],
    }
}

export const commands = {
    list: (event, core) => {
        const access = loadAccess()
        const isCommandCenter = String(event.chatId) === String(access.commandCenterChatId ?? "")
        if (event.chatType !== "private" && !isCommandCenter) {
            return { effects: [] }
        }
        const senderId = String(event.userId ?? "")
        if (!isCommandCenter && !access.allowFrom.includes(senderId)) {
            return { effects: [] }
        }

        const replyTo = event._replyTo ?? replyToFromEvent(event, "cmd:list")

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
            // Live IPC conn — stripped on persist-load, re-populated
            // when the shim re-registers. `hasConn` distinguishes a
            // reachable session from a zombie metadata entry.
            hasConn: !!s._conn,
        }))

        const replyOpts = { parse_mode: "HTML" }

        if (sessions.length === 0) {
            return reply(replyTo, "No sessions connected. Use /new to make one from here", replyOpts)
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

        return reply(replyTo, parts.join("\n\n"), replyOpts)
    },
}
