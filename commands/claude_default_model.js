// commands/claude_default_model.js — show or set the default Claude model.
//
// The default is cbg's `session_model`, which new cbg chats launch with. Claude
// Code's `/model` also saves every pick into ~/.claude/settings.json as the
// default for new sessions, so this command writes the same value there, and
// `/claude_default_model --sync` (fired by /model shortly after a switch) puts
// settings.json back to `session_model` without replying.

import { versionedImport } from "../lib/version.js"
const { replyToFromEvent, sendEffect } = await versionedImport("../lib/pure/reply-to.js", import.meta)
const { getSessionModelArgs, setSessionModel } = await versionedImport("../lib/config-manager.js", import.meta)
const { dbg } = await versionedImport("../lib/logging.js", import.meta)
const { paths } = await versionedImport("../lib/paths.js", import.meta)

export const tips = [
    "/claude_default_model <name> sets the model new sessions start with; plain /model only switches the current one.",
]

export const descriptions = {
    claude_default_model: "Show or set the default Claude model for new sessions",
}

/** A write_file effect pointing Claude's settings.json "model" at `model`, or null if it already does. */
function claudeSettingsModelEffect(model) {
    const settings = JSON.parse(Deno.readTextFileSync(paths.CLAUDE_SETTINGS))
    if (settings.model === model) {
        return null
    }
    return { type: "write_file", path: paths.CLAUDE_SETTINGS, content: JSON.stringify({ ...settings, model }, null, 2) + "\n" }
}

export const commands = {
    claude_default_model: (event, _core) => {
        const arg = (event.text ?? "").split(/\s+/).slice(1).join(" ").trim()
        const current = getSessionModelArgs().replace(/^--model\s+/, "") || null
        if (arg === "--sync") {
            if (!current) {
                return {}
            }
            try {
                const effect = claudeSettingsModelEffect(current)
                return { effects: effect ? [effect] : [] }
            } catch (err) {
                dbg("DEFAULT-MODEL", "sync failed:", err)
                return {}
            }
        }
        const replyTo = replyToFromEvent(event, "cmd/claude_default_model")
        if (!arg) {
            return { effects: [sendEffect(replyTo, `Default model: ${current ?? "not set (Claude picks)"}\nChange it: /claude_default_model claude-opus-5-5`)] }
        }
        if (!/^[\w.\-\[\]]+$/.test(arg)) {
            return { effects: [sendEffect(replyTo, `"${arg}" doesn't look like a model name.`)] }
        }
        setSessionModel(arg)
        const settingsEffect = claudeSettingsModelEffect(arg)
        return { effects: [...(settingsEffect ? [settingsEffect] : []), sendEffect(replyTo, `Default model is now ${arg} (new cbg chats + Claude's saved default).`)] }
    },
}
