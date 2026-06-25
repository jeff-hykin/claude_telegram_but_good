// commands/notes.js — per-topic scratch notes (plain .txt), just for the user.
//
// Three forms (the regex in chat-user.js only captures `\w+` for the command
// name, so `/notes`, `/notes+`, and `/notes-` all dispatch here as `notes`;
// we re-parse the trailing +/- ourselves from event.text):
//   /notes            → echo the topic's notes
//   /notes+ <text>    → append <text> to the topic's notes
//   /notes- <text>    → overwrite the whole note with <text>

import { versionedImport } from "../lib/version.js"

const { paths } = await versionedImport("../lib/paths.js", import.meta)
const { loadAccess } = await versionedImport("../lib/access.js", import.meta)
const { replyToFromEvent, sendEffect } = await versionedImport("../lib/pure/reply-to.js", import.meta)

export const tips = [
    "/notes shows this topic's notes — /notes+ <text> appends, /notes- <text> overwrites",
]

export const descriptions = {
    notes: "Per-topic scratch notes: /notes (show), /notes+ <text> (append), /notes- <text> (overwrite)",
    note: "Alias of /notes where /note+ <text> adds a bulleted item (\"- <text>\")",
}

// Resolve a stable, human-readable directory key for the current topic. In a
// command-center group that's the topic name; in a DM there is no topic, so we
// fall back to a per-chat key so each DM keeps its own notes.
function notesPathForEvent(event, core) {
    const cc = core.chatState?.commandCenter ?? {}
    const threadId = event.threadId
    const topicName = threadId ? (cc.topicNames?.[String(threadId)] ?? null) : null
    const key = topicName || `dm-${event.chatId}`
    return `${paths.topicDir(key)}/notes.txt`
}

function readNotes(path) {
    try {
        return Deno.readTextFileSync(path)
    } catch (e) {
        // Missing file is the normal "no notes yet" case — anything else we
        // surface as empty too, but it's worth a debug line.
        if (!(e instanceof Deno.errors.NotFound)) {
            const { dbg } = globalThis
            if (typeof dbg === "function") { dbg("NOTES", `read failed for ${path}:`, e) }
        }
        return ""
    }
}

// The two command names share one notes file per topic and the same +/-
// semantics. The only difference: `/note+` formats each append as a bulleted
// item ("- <text>\n"), while `/notes+` appends the raw line.
//
// `cmdName` is the literal command word ("notes" or "note") so we can build the
// matching regex and usage strings; `bulletItems` toggles the item formatting.
function makeHandler(cmdName, bulletItems) {
    return (event, core) => {
        const access = loadAccess()
        const isCommandCenter = String(event.chatId) === String(access.commandCenterChatId ?? "")
        if (event.chatType !== "private" && !isCommandCenter) {
            return { effects: [] }
        }
        const senderId = String(event.userId ?? "")
        if (!isCommandCenter && !access.allowFrom?.includes(senderId)) {
            return { effects: [] }
        }

        const replyTo = replyToFromEvent(event, `cmd/${cmdName}`)
        const path = notesPathForEvent(event, core)

        // Capture the +/- mode and the rest of the line. The command name match
        // in chat-user.js stops at the first non-word char, so the +/- is still
        // here in event.text.
        const match = new RegExp(`^\\/${cmdName}([+-])?\\s*([\\s\\S]*)$`, "i").exec((event.text || "").trim())
        const mode = match?.[1] ?? null
        const arg = (match?.[2] ?? "").trim()

        // Show
        if (!mode) {
            const current = readNotes(path)
            const body = current.trim() ? current : `(no notes yet — /${cmdName}+ <text> to add some)`
            return { effects: [sendEffect(replyTo, body, { format: "plain" })] }
        }

        if (!arg) {
            const usage = mode === "+"
                ? `Usage: /${cmdName}+ <text to ${bulletItems ? "add as an item" : "append"}>`
                : `Usage: /${cmdName}- <text to replace the whole note with>`
            return { effects: [sendEffect(replyTo, usage, { format: "plain" })] }
        }

        // Append (bulleted for /note+, raw line for /notes+)
        if (mode === "+") {
            const line = bulletItems ? `- ${arg}` : arg
            const current = readNotes(path)
            const next = current.trim() ? `${current.replace(/\n+$/, "")}\n${line}\n` : `${line}\n`
            return {
                effects: [
                    { type: "write_file", path, content: next },
                    sendEffect(replyTo, `Added. ${next.length} chars total.`, { format: "plain" }),
                ],
            }
        }

        // Overwrite (mode === "-")
        const next = `${arg}\n`
        return {
            effects: [
                { type: "write_file", path, content: next },
                sendEffect(replyTo, `Overwrote notes. ${next.length} chars total.`, { format: "plain" }),
            ],
        }
    }
}

export const commands = {
    notes: makeHandler("notes", false),
    note: makeHandler("note", true),
}
