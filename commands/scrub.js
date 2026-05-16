// commands/scrub.js — manage find-and-replace scrub rules for disk writes.
//
// Rules are stored base64-encoded at $CBG_DIR/scrub-rules.b64 so that
// greps for the sensitive terms won't match the rules file itself.

import { versionedImport } from "../lib/version.js"

const { replyToFromEvent, sendEffect } = await versionedImport("../lib/pure/reply-to.js", import.meta)
const { escapeMarkdown } = await versionedImport("../lib/pure/markdown.js", import.meta)
const { loadRules, saveRules } = await versionedImport("../lib/scrub.js", import.meta)

export const tips = [
    "/scrub_add florp sudo — replaces 'florp' with 'sudo' in all disk writes",
]

export const descriptions = {
    scrub_add: "Add a scrub rule: /scrub_add <find> <replace>",
    scrub_remove: "Remove a scrub rule: /scrub_remove <find>",
    scrub_list: "List all active scrub rules",
}

export const commands = {
    scrub_add: (event, _core) => {
        const replyTo = replyToFromEvent(event, "cmd/scrub_add")
        const text = (event.text || "").replace(/^\/scrub_add\s*/i, "").trim()

        // Parse: everything before the last whitespace-separated word is "find",
        // the last word is "replace". Or support quoted strings.
        const parts = parseArgs(text)
        if (parts.length < 2) {
            return {
                effects: [sendEffect(replyTo, "Usage: /scrub_add <find> <replace>\n\nExample: /scrub_add florp sudo", { format: "plain" })],
            }
        }

        const [find, replace] = parts
        const rules = loadRules()

        // Check for duplicate
        const existing = rules.findIndex(r => r.find.toLowerCase() === find.toLowerCase())
        if (existing >= 0) {
            rules[existing].replace = replace
        } else {
            rules.push({ find, replace })
        }

        saveRules(rules)

        const verb = existing >= 0 ? "Updated" : "Added"
        return {
            effects: [sendEffect(replyTo,
                `${verb} scrub rule. ${rules.length} rule(s) active.`,
                { format: "plain" },
            )],
        }
    },

    scrub_remove: (event, _core) => {
        const replyTo = replyToFromEvent(event, "cmd/scrub_remove")
        const find = (event.text || "").replace(/^\/scrub_remove\s*/i, "").trim()

        if (!find) {
            return {
                effects: [sendEffect(replyTo, "Usage: /scrub_remove <find>", { format: "plain" })],
            }
        }

        const rules = loadRules()
        const idx = rules.findIndex(r => r.find.toLowerCase() === find.toLowerCase())
        if (idx < 0) {
            return {
                effects: [sendEffect(replyTo, `No rule found matching "${find}".`, { format: "plain" })],
            }
        }

        rules.splice(idx, 1)
        saveRules(rules)

        return {
            effects: [sendEffect(replyTo, `Removed. ${rules.length} rule(s) remaining.`, { format: "plain" })],
        }
    },

    scrub_list: (event, _core) => {
        const replyTo = replyToFromEvent(event, "cmd/scrub_list")
        const rules = loadRules()

        if (rules.length === 0) {
            return {
                effects: [sendEffect(replyTo, "No scrub rules configured.", { format: "plain" })],
            }
        }

        const lines = rules.map((r, i) =>
            `${i + 1}. \`${escapeMarkdown(r.find)}\` → \`${escapeMarkdown(r.replace)}\``
        )
        const text = `*Scrub rules (${rules.length})*\n\n${lines.join("\n")}`

        return {
            effects: [sendEffect(replyTo, text, { format: "markdown" })],
        }
    },
}

/**
 * Parse "find replace" from command text.
 * Supports quoted strings: /scrub_add "outer space" "idk"
 * Or unquoted two-word: /scrub_add florp sudo
 */
function parseArgs(text) {
    const args = []
    let remaining = text.trim()

    for (let i = 0; i < 2 && remaining.length > 0; i++) {
        if (remaining[0] === '"' || remaining[0] === "'") {
            const quote = remaining[0]
            const end = remaining.indexOf(quote, 1)
            if (end < 0) {
                // Unclosed quote — take rest
                args.push(remaining.slice(1))
                remaining = ""
            } else {
                args.push(remaining.slice(1, end))
                remaining = remaining.slice(end + 1).trim()
            }
        } else {
            // For the first arg, take up to the last space (greedy for find)
            // For the second arg, take the rest
            if (i === 0) {
                // If there are quoted parts later, find the boundary
                // Simple approach: split on space, first token is find, rest is replace
                // But we want multi-word find to work with quotes.
                // Without quotes: first word = find, second word = replace
                const spaceIdx = remaining.indexOf(" ")
                if (spaceIdx < 0) {
                    args.push(remaining)
                    remaining = ""
                } else {
                    args.push(remaining.slice(0, spaceIdx))
                    remaining = remaining.slice(spaceIdx + 1).trim()
                }
            } else {
                args.push(remaining)
                remaining = ""
            }
        }
    }

    return args
}
