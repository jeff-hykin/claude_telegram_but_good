// commands/mem.js — Show the topic memory file path and beginning content.

import { versionedImport } from "../lib/version.js"
const { paths } = await versionedImport("../lib/paths.js", import.meta)
const { replyToFromEvent, sendEffect } = await versionedImport("../lib/pure/reply-to.js", import.meta)
const { escapeMarkdown } = await versionedImport("../lib/pure/markdown.js", import.meta)

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
            text = `*Topic memory*\n\n\`${escapeMarkdown(memoryFile)}\`\n\n_(file does not exist yet)_`
        } else {
            const lines = content.split("\n")
            const preview = lines.slice(0, PREVIEW_LINES).join("\n")
            const truncated = lines.length > PREVIEW_LINES
                ? `\n\n_... (${lines.length - PREVIEW_LINES} more lines)_`
                : ""
            text = `*Topic memory*\n\n\`${escapeMarkdown(memoryFile)}\`\n\n\`\`\`\n${escapeMarkdown(preview)}\n\`\`\`${truncated}`
        }

        return {
            effects: [sendEffect(replyTo, text, { parse_mode: "Markdown" })],
        }
    },
}
