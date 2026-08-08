// commands/output_replace.js — manage find-and-replace rules applied to
// text on its way out to Telegram (see lib/output-replace.js).

import { versionedImport } from "../lib/version.js"

const { replyToFromEvent, sendEffect } = await versionedImport("../lib/pure/reply-to.js", import.meta)
const { loadRules, saveRules, parseFindReplace } = await versionedImport("../lib/output-replace.js", import.meta)

export const tips = [
    "/output_replace_add florp sudo — rewrites 'florp' to 'sudo' in every message sent to Telegram",
]

export const descriptions = {
    output_replace_add: "Add an outbound replace rule: /output_replace_add <find> <replace>",
    output_replace_remove: "Remove an outbound replace rule: /output_replace_remove <find>",
    output_replace_list: "List all outbound replace rules",
}

const usage = 'Usage: /output_replace_add <find> <replace>\n\nExample: /output_replace_add florp sudo\nQuote to include spaces or delete: /output_replace_add "hello there" ""\nMatching is literal and case-sensitive.'

export const commands = {
    output_replace_add: (event, _core) => {
        const replyTo = replyToFromEvent(event, "cmd/output_replace_add")
        const args = parseFindReplace((event.text || "").replace(/^\/output_replace_add\s*/i, ""))
        if (args.length < 2 || args[0].length === 0) {
            return { effects: [sendEffect(replyTo, usage, { format: "plain" })] }
        }

        const [find, replace] = args
        const rules = loadRules()
        const existing = rules.findIndex((rule) => rule.find === find)
        if (existing >= 0) {
            rules[existing].replace = replace
        } else {
            rules.push({ find, replace })
        }
        saveRules(rules)

        const verb = existing >= 0 ? "Updated" : "Added"
        return {
            effects: [sendEffect(replyTo, `${verb} output replace rule. ${rules.length} rule(s) active.`, { format: "plain" })],
        }
    },

    output_replace_remove: (event, _core) => {
        const replyTo = replyToFromEvent(event, "cmd/output_replace_remove")
        const [find] = parseFindReplace((event.text || "").replace(/^\/output_replace_remove\s*/i, ""))
        if (!find) {
            return { effects: [sendEffect(replyTo, "Usage: /output_replace_remove <find>", { format: "plain" })] }
        }

        const rules = loadRules()
        const index = rules.findIndex((rule) => rule.find === find)
        if (index < 0) {
            return { effects: [sendEffect(replyTo, `No output replace rule found for "${find}".`, { format: "plain" })] }
        }

        rules.splice(index, 1)
        saveRules(rules)
        return {
            effects: [sendEffect(replyTo, `Removed. ${rules.length} rule(s) remaining.`, { format: "plain" })],
        }
    },

    output_replace_list: (event, _core) => {
        const replyTo = replyToFromEvent(event, "cmd/output_replace_list")
        const rules = loadRules()
        if (rules.length === 0) {
            return { effects: [sendEffect(replyTo, "No output replace rules configured.", { format: "plain" })] }
        }

        const lines = rules.map((rule, index) => `${index + 1}. ${rule.find} -> ${rule.replace}`)
        const text = `Output replace rules (${rules.length})\n\n${lines.join("\n")}`
        // skipOutputReplace: otherwise every rule rewrites itself in this
        // listing (rule "florp -> sudo" would print as "sudo -> sudo").
        return {
            effects: [{ ...sendEffect(replyTo, text, { format: "plain" }), skipOutputReplace: true }],
        }
    },
}
