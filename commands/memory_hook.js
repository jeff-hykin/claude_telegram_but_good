// commands/memory_hook.js — manage keyword-triggered reminders.
//
// A hook pairs a pattern with a hint; whenever the pattern shows up in a
// user message, an agent reply, or an agent's tool call, the hint is put in
// front of the agent. See lib/memory-hooks.js for the trigger points.

import { versionedImport } from "../lib/version.js"

const { loadAccess } = await versionedImport("../lib/access.js", import.meta)
const { replyToFromEvent, sendEffect } = await versionedImport("../lib/pure/reply-to.js", import.meta)
const { loadHooks, addHook, removeHook, parseHookArgs } = await versionedImport("../lib/memory-hooks.js", import.meta)

export const tips = [
    "/memory_hook dimos if uncertain, see jhist — every message mentioning dimos reminds the agent where to look.",
    "/memory_hook /Manipulation Weekly/, jeff doesn't attend that — wrap a pattern in slashes to use a regex.",
]

export const descriptions = {
    memory_hook: "Add a keyword reminder: /memory_hook <keyword|/regex/> <hint>",
    memory_hooks: "List all memory hooks",
}

const usage = "Usage: /memory_hook <keyword or /regex/> <hint>\n\n" +
    "Examples:\n" +
    "  /memory_hook dimos if uncertain, see jhist\n" +
    '  /memory_hook /Manipulation Weekly/, jeff doesn\'t attend that\n\n' +
    "A bare keyword matches anywhere, case-insensitively. Wrap in slashes for a regex.\n" +
    "The hint is shown to the agent when the pattern appears in your message, in the agent's\n" +
    "reply (which gets held back so it can correct itself), or in a tool it just ran.\n\n" +
    "/memory_hooks lists them."

function isAllowed(event) {
    const access = loadAccess()
    const isCommandCenter = String(event.chatId) === String(access.commandCenterChatId ?? "")
    if (event.chatType !== "private" && !isCommandCenter) {
        return false
    }
    return isCommandCenter || access.allowFrom?.includes(String(event.userId ?? ""))
}

export const commands = {
    memory_hook: (event, _core) => {
        if (!isAllowed(event)) {
            return { effects: [] }
        }
        const replyTo = replyToFromEvent(event, "cmd/memory_hook")
        const argText = (event.text || "").replace(/^\/memory_hook\s*/i, "")
        const parsed = parseHookArgs(argText)
        if (!parsed) {
            return { effects: [sendEffect(replyTo, usage, { format: "plain" })] }
        }

        const result = addHook(parsed)
        if (result.error) {
            return { effects: [sendEffect(replyTo, result.error, { format: "plain" })] }
        }

        const verb = result.updated ? "Updated" : "Added"
        const text = `${verb} memory hook.\n\n${result.hook.pattern}\n  -> ${result.hook.hint}\n\n` +
            `${result.total} hook(s) active. Remove with /memory_hook_remove_${result.hook.id}`
        return { effects: [sendEffect(replyTo, text, { format: "plain" })] }
    },

    memory_hooks: (event, _core) => {
        if (!isAllowed(event)) {
            return { effects: [] }
        }
        const replyTo = replyToFromEvent(event, "cmd/memory_hooks")
        const hooks = loadHooks()
        if (hooks.length === 0) {
            return {
                effects: [sendEffect(replyTo, "No memory hooks configured.\n\n" + usage, { format: "plain" })],
            }
        }

        const lines = hooks.map((hook) => {
            const scope = hook.on && hook.on !== "both" ? ` [${hook.on} only]` : ""
            return `${hook.pattern}${scope}\n  -> ${hook.hint}\n  /memory_hook_remove_${hook.id}`
        })
        const text = `Memory hooks (${hooks.length})\n\n${lines.join("\n\n")}`
        return { effects: [sendEffect(replyTo, text, { format: "plain" })] }
    },

    memory_hook_remove: (event, _core) => {
        if (!isAllowed(event)) {
            return { effects: [] }
        }
        const replyTo = replyToFromEvent(event, "cmd/memory_hook_remove")
        const arg = (event.text || "").replace(/^\/memory_hook_remove\s*/i, "").trim()
        if (!arg) {
            return {
                effects: [sendEffect(replyTo, "Usage: /memory_hook_remove <id or pattern>. Run /memory_hooks to see them.", { format: "plain" })],
            }
        }
        const result = removeHook(arg)
        return {
            effects: [sendEffect(
                replyTo,
                result.error ? result.error : `Removed memory hook ${result.hook.pattern}. ${result.total} left.`,
                { format: "plain" },
            )],
        }
    },
}
