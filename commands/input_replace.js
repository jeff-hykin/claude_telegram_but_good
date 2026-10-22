// commands/input_replace.js — manage find-and-replace rules applied to
// the user's text on its way in to a session (see lib/input-replace.js).

import { versionedImport } from "../lib/version.js"

const { replyToFromEvent, sendEffect } = await versionedImport("../lib/pure/reply-to.js", import.meta)
const { loadRules, saveRules } = await versionedImport("../lib/input-replace.js", import.meta)
const { parseFindReplace } = await versionedImport("../lib/output-replace.js", import.meta)

export const tips = [
    "/input_replace_add idu \"I don't understand\" — expands the word 'idu' in everything you send to a session",
]

export const descriptions = {
    input_replace_add: "Add an inbound replace rule: /input_replace_add <word> <replace>",
    input_replace_remove: "Remove an inbound replace rule: /input_replace_remove <word>",
    input_replace_list: "List all inbound replace rules",
}

const usage = 'Usage: /input_replace_add <word> <replace>\n\nExample: /input_replace_add idu "I don\'t understand"\nQuote to include spaces or delete: /input_replace_add "hello there" ""\nMatches whole words only, case-insensitively.'

export const commands = {
    input_replace_add: (event, _core) => {
        const replyTo = replyToFromEvent(event, "cmd/input_replace_add")
        const args = parseFindReplace((event.text || "").replace(/^\/input_replace_add\s*/i, ""))
        if (args.length < 2 || args[0].length === 0) {
            return { effects: [sendEffect(replyTo, usage, { format: "plain" })] }
        }

        const [find, replace] = args
        const rules = loadRules()
        const existing = rules.findIndex((rule) => rule.find.toLowerCase() === find.toLowerCase())
        if (existing >= 0) {
            rules[existing] = { find, replace }
        } else {
            rules.push({ find, replace })
        }
        saveRules(rules)

        const verb = existing >= 0 ? "Updated" : "Added"
        return {
            effects: [sendEffect(replyTo, `${verb} input replace rule. ${rules.length} rule(s) active.`, { format: "plain" })],
        }
    },

    input_replace_remove: (event, _core) => {
        const replyTo = replyToFromEvent(event, "cmd/input_replace_remove")
        const [find] = parseFindReplace((event.text || "").replace(/^\/input_replace_remove\s*/i, ""))
        if (!find) {
            return { effects: [sendEffect(replyTo, "Usage: /input_replace_remove <word>", { format: "plain" })] }
        }

        const rules = loadRules()
        const index = rules.findIndex((rule) => rule.find.toLowerCase() === find.toLowerCase())
        if (index < 0) {
            return { effects: [sendEffect(replyTo, `No input replace rule found for "${find}".`, { format: "plain" })] }
        }

        rules.splice(index, 1)
        saveRules(rules)
        return {
            effects: [sendEffect(replyTo, `Removed. ${rules.length} rule(s) remaining.`, { format: "plain" })],
        }
    },

    input_replace_list: (event, _core) => {
        const replyTo = replyToFromEvent(event, "cmd/input_replace_list")
        const rules = loadRules()
        if (rules.length === 0) {
            return { effects: [sendEffect(replyTo, "No input replace rules configured.", { format: "plain" })] }
        }

        const lines = rules.map((rule, index) => `${index + 1}. ${rule.find} -> ${rule.replace}`)
        return {
            effects: [sendEffect(replyTo, `Input replace rules (${rules.length})\n\n${lines.join("\n")}`, { format: "plain" })],
        }
    },
}
