// commands/mem.js — Show the topic memory file path and beginning content.

import { versionedImport } from "../lib/version.js"
const { paths } = await versionedImport("../lib/paths.js", import.meta)
const { replyToFromEvent, sendEffect } = await versionedImport("../lib/pure/reply-to.js", import.meta)
const { escapeHtml } = await versionedImport("../lib/pure/html.js", import.meta)

const PREVIEW_LINES = 30

export const descriptions = {
    mem: "Show the topic memory file path and contents",
}

export const commands = {
    mem: (event, core) => {
        const replyTo = replyToFromEvent(event, "cmd/mem")
        const threadId = event.threadId
        if (!threadId) {
            return {
                effects: [sendEffect(replyTo, "This command only works inside a command center topic.")],
            }
        }

        const cc = core.chatState?.commandCenter ?? {}
        const threadKey = String(threadId)
        const topicName = cc.topicNames?.[threadKey] ?? null

        if (!topicName) {
            return {
                effects: [sendEffect(replyTo, "No topic name found for this thread.")],
            }
        }

        const memoryFile = paths.topicMemoryFile(topicName)
        let content = null
        try {
            content = Deno.readTextFileSync(memoryFile)
        } catch {
            // file doesn't exist yet
        }

        let text
        if (!content) {
            text = `<b>Topic memory</b>\n\n<code>${escapeHtml(memoryFile)}</code>\n\n<i>(file does not exist yet)</i>`
        } else {
            const lines = content.split("\n")
            const preview = lines.slice(0, PREVIEW_LINES).join("\n")
            const truncated = lines.length > PREVIEW_LINES
                ? `\n\n<i>... (${lines.length - PREVIEW_LINES} more lines)</i>`
                : ""
            text = `<b>Topic memory</b>\n\n<code>${escapeHtml(memoryFile)}</code>\n\n<pre>${escapeHtml(preview)}</pre>${truncated}`
        }

        return {
            effects: [sendEffect(replyTo, text, { parse_mode: "HTML" })],
        }
    },
}
