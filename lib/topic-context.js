// lib/topic-context.js — the continuity bundle handed to a new session.
//
// A topic outlives the sessions inside it. Whenever a session is replaced
// — /refresh, or /backend moving the topic to a different agent — the
// replacement starts with an empty head, so it gets a file holding the
// topic's persistent memory plus the tail of the old conversation.
//
// Shared by commands/refresh.js and commands/backend.js. The prompt is
// built here too, so both paths tell the new session about its memory
// file in the same words.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { versionedImport } from "./version.js"

const { dbg } = await versionedImport("./logging.js", import.meta)
const { paths } = await versionedImport("./paths.js", import.meta)
const { tailColdStream } = await versionedImport("./cold-storage.js", import.meta)

const CONTEXT_MESSAGE_LIMIT = 50

/** The last few messages of a session, as plain transcript text. */
export function gatherSessionContext(oldSessionId) {
    if (!oldSessionId) { return null }
    try {
        const all = tailColdStream("messages", 500)
        const sessionMsgs = all.filter(m => m.sessionId === oldSessionId && m.text)
        const recent = sessionMsgs.slice(-CONTEXT_MESSAGE_LIMIT)
        if (recent.length === 0) { return null }
        const lines = recent.map(m => {
            const who = m.from === "user" ? "User" : "Agent"
            const ts = m.ts ? new Date(m.ts).toISOString().slice(0, 16) : ""
            const text = (m.text ?? "").slice(0, 500)
            return `[${ts}] ${who}: ${text}`
        })
        return { count: recent.length, text: lines.join("\n\n") }
    } catch (e) {
        dbg("TOPIC-CONTEXT", "gatherSessionContext failed:", e)
        return null
    }
}

/**
 * Write the handoff file for a new session in an existing topic and
 * build the prompt that points at it.
 *
 * @param {object} args
 * @param {string} args.sessionId — the NEW session
 * @param {string} args.title — topic name, which is also the memory dir
 * @param {string} [args.oldSessionId] — the session being replaced
 * @returns {{topicMemoryFile: string, contextFile: string|null, note: string, prompt: string}}
 */
export function prepareTopicHandoff({ sessionId, title, oldSessionId }) {
    const context = gatherSessionContext(oldSessionId)
    const topicMemoryFile = paths.topicMemoryFile(title)

    let topicMemory = null
    try {
        if (existsSync(topicMemoryFile)) {
            topicMemory = readFileSync(topicMemoryFile, "utf8").trim()
        }
    } catch (e) {
        dbg("TOPIC-CONTEXT", "read topic memory failed:", e)
    }

    // So the new session can write memory.md without mkdir'ing first.
    try {
        mkdirSync(paths.topicDir(title), { recursive: true })
    } catch (e) {
        dbg("TOPIC-CONTEXT", "mkdir topic dir failed:", e)
    }

    let contextFile = null
    if (context || topicMemory) {
        contextFile = join(paths.STATE_DIR, `refresh-context-${sessionId}.md`)
        const sections = []

        if (topicMemory) {
            sections.push(
                `# Topic memory`,
                ``,
                `This is the persistent memory for this topic. It was written by previous sessions and survives across refreshes.`,
                ``,
                topicMemory,
            )
        }

        if (context) {
            sections.push(
                `# Recent conversation history`,
                ``,
                `The following is the recent conversation history (last ${context.count} messages) from the previous session in this topic.`,
                ``,
                context.text,
            )
        }

        sections.push(
            `# Topic memory file`,
            ``,
            `Your topic memory file is at: ${topicMemoryFile}`,
            `Update this file regularly as you work — it persists across session refreshes and is the primary way context is preserved for the next session in this topic.`,
            `Keep it concise and focused: what's being worked on, current state, key decisions, and next steps.`,
        )

        try {
            writeFileSync(contextFile, sections.join("\n"))
        } catch (e) {
            dbg("TOPIC-CONTEXT", "failed to write context file:", e)
            contextFile = null
        }
    }

    const parts = []
    if (topicMemory) { parts.push("topic memory") }
    if (context) { parts.push(`last ${context.count} messages`) }
    const note = parts.length > 0
        ? `\nSending ${parts.join(" + ")} for context.`
        : (oldSessionId ? `\nNo message history found for previous session — starting fresh.` : "")

    const prompt = contextFile
        ? `Read the file ${contextFile} for context from the previous session in this topic. Then briefly acknowledge what was being discussed and ask how you can help. Remember to update your topic memory file at ${topicMemoryFile} as you work.`
        : `You have a topic memory file at ${topicMemoryFile}. Update it regularly as you work — it persists across session refreshes and helps future sessions understand what was done. Ask how you can help.`

    return { topicMemoryFile, contextFile, note, prompt }
}
