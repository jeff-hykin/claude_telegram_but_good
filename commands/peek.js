// commands/peek.js — Action-returning hot command.
//
// Reads the dtach log file of a session, strips terminal escape
// sequences, collapses repeated "Thinking…" blocks, and sends a tail
// of the cleaned content as an HTML <pre> block.

import { readFileSync } from "node:fs"
import { versionedImport } from "../lib/version.js"
const { loadAccess } = await versionedImport("../lib/access.js", import.meta)
const { dbg } = await versionedImport("../lib/logging.js", import.meta)
const { escapeHtml: escHtml } = await versionedImport("../lib/pure/html.js", import.meta)

export const tips = [
    "/peek shows what a session is doing right now — no need to attach.",
    "/peek 100 shows more output, /peek &lt;session_id&gt; peeks at a specific session.",
]

const DEFAULT_LINES = 40
const SECTION_MARKERS = /[◯✻✳✶✢←⏺]/

function extractWords(raw) {
    let text = raw
        .replace(/\x1b\[2J|\x1b\[H|\x1bc/g, "\n---\n")
        .replace(/\x1b\[\d+;\d+[Hf]/g, " ")
        .replace(/\x1b\[\d*[ABCD]/g, " ")
        .replace(/\x1b\[\d*[KJ]/g, " ")
        .replace(/\x1b\[\d*C/g, " ")
        .replace(/\x1b\[[\d;]*[mG]/g, "")
        .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
        .replace(/\x1b\[[0-9;?]*[a-zA-Z~@]/g, "")
        .replace(/\x1b[>=<#]/g, "")
        .replace(/\x1b[()][0-9A-Za-z]/g, "")
        .replace(/\x1b./g, "")
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
        .replace(/>[0-9]+[a-z]/g, "")
        .replace(/<[a-z]/g, "")

    const lines = text.split(/\r?\n/)
    const cleanLines = []
    for (const line of lines) {
        const cleaned = line
            .replace(/\b[✻✶*✢·⏵◯⎿❯]\s+[a-z]\s+/g, " ")
            .replace(/\b[\d✻✶*✢·]+(?:\s+[\d✻✶*✢·])*\b/g, " ")
            .replace(/[─━│┃┌┐└┘├┤┬┴┼╔╗╚╝╠╣╦╩╬═║]{3,}/g, " --- ")
            .replace(/[▐▌▛▜▘▝▗▖█▀▄▞▟▙▚░▒▓]{2,}/g, "")
            .replace(/\s+/g, " ")
            .trim()
        if (cleaned && cleaned.length > 2) {
            cleanLines.push(cleaned)
        }
    }
    return cleanLines.join(" ")
}

function collapseThinking(text) {
    const OTHER_SECTION = /[⏺◯✳✶✢←]/
    const markers = []
    const re = /Thinking…/g
    let m
    while ((m = re.exec(text)) !== null) {
        markers.push(m.index)
    }
    if (markers.length < 2) { return text }

    const toRemove = []
    for (let i = 0; i < markers.length - 1; i++) {
        const between = text.slice(markers[i] + "Thinking…".length, markers[i + 1])
        if (!OTHER_SECTION.test(between)) {
            toRemove.push([markers[i], markers[i + 1]])
        }
    }
    if (toRemove.length === 0) { return text }

    let out = ""
    let cursor = 0
    for (const [s, e] of toRemove) {
        out += text.slice(cursor, s)
        cursor = e
    }
    out += text.slice(cursor)
    return out
}

export const descriptions = {
    peek: "Show recent output of a session",
}

function reply(chatId, text, options) {
    return { effects: [{ type: "send_text_to_user", chatId, text, ...(options ? { options } : {}) }] }
}

export const commands = {
    peek: (event, core) => {
        if (event.chatType !== "private") { return { effects: [] } }
        const access = loadAccess()
        if (!access.allowFrom.includes(String(event.userId ?? ""))) {
            return { effects: [] }
        }

        const argText = (event.text ?? "").replace(/^\/peek\s*/, "").trim()
        const args = argText.split(/\s+/).filter(Boolean)

        let targetId = null
        let lineCount = DEFAULT_LINES
        for (const arg of args) {
            if (/^\d+$/.test(arg)) {
                lineCount = parseInt(arg, 10)
            } else {
                targetId = arg
            }
        }

        const sessionsMap = core.chatSessions ?? {}
        const sessions = Object.values(sessionsMap)
        let session = null
        if (targetId) {
            session = sessions.find(s => s.id === targetId)
            if (!session) {
                return reply(event.chatId, `Session "${targetId}" not found. Use /list to see available sessions.`)
            }
        } else {
            const focusedId = core.chatState?.focusedSessionId
            if (focusedId) {
                session = sessions.find(s => s.id === focusedId)
            }
            if (!session && sessions.length > 0) {
                session = sessions[0]
            }
        }
        if (!session) { return reply(event.chatId, "No active sessions.") }

        const dtachSocket = session.dtachSocket
        if (!dtachSocket) {
            return reply(event.chatId, `Session "${session.id}" has no dtach socket — can't find log file.`)
        }
        const logPath = dtachSocket.replace(/\.sock$/, ".log")

        let content
        try {
            content = readFileSync(logPath, "utf8")
        } catch (e) {
            dbg("PEEK", `read ${logPath} failed:`, e)
            return reply(event.chatId, `No log file found for session "${session.id}".`)
        }
        if (!content.trim()) {
            return reply(event.chatId, `Log file for session "${session.id}" is empty.`)
        }

        const words = collapseThinking(extractWords(content))
        if (!words) {
            return reply(event.chatId, `Log file for session "${session.id}" is empty.`)
        }

        const wordList = words.split(" ")
        const approxWords = lineCount * 10
        const tail = wordList.slice(-approxWords).join(" ")

        const header = `${session.id}${session.title ? ` (${session.title})` : ""}:`
        let body = tail
        if (header.length + body.length + 10 > 4096) {
            body = body.slice(-(4096 - header.length - 10))
            body = "..." + body
        }

        return reply(
            event.chatId,
            `${escHtml(header)}\n<pre>${escHtml(body)}</pre>`,
            { parse_mode: "HTML" },
        )
    },
}
