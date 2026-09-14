// commands/auto_background.js — Action-returning hot command.
//
// Per-topic switch for the slow-tool watchdog (lib/event-handlers/
// slow-tool-check.js): a tool call still running after N seconds is moved
// to the background so the session stays responsive. On everywhere by
// default at the `slow_tool_background_ms` config threshold (10 s).
//
//   /auto_background          → show this topic's setting
//   /auto_background off      → never background tool calls in this topic
//   /auto_background on       → back to the default (on, config threshold)
//   /auto_background 30       → this topic backgrounds after 30 s (45s, 2m also work)
//
// Only overrides are stored (chatState.autoBackground[<chat>:<thread>]),
// see lib/pure/auto-background.js.

import { versionedImport } from "../lib/version.js"
const { loadAccess } = await versionedImport("../lib/access.js", import.meta)
const { commandScope } = await versionedImport("../lib/command-scope.js", import.meta)
const { replyToFromEvent, sendEffect } = await versionedImport("../lib/pure/reply-to.js", import.meta)
const { getSlowToolBackgroundMs } = await versionedImport("../lib/config-manager.js", import.meta)
const {
    autoBackgroundKey,
    resolveAutoBackground,
    parseAutoBackgroundArg,
    formatThreshold,
} = await versionedImport("../lib/pure/auto-background.js", import.meta)

export const tips = [
    "/auto_background off stops cbg from backgrounding this topic's slow tool calls (ctrl+b after 10s by default).",
    "/auto_background 45 makes this topic wait 45s before backgrounding a tool call.",
]

export const descriptions = {
    auto_background: "Show or change when this topic's slow tool calls get backgrounded (/auto_background off | on | 30)",
}

function describe(setting) {
    if (!setting.enabled) {
        return "Auto-background is *off* for this topic — slow tool calls stay in the foreground."
    }
    const source = setting.overridden ? "topic override" : "default"
    return `Auto-background is *on* for this topic: a tool call still running after ${formatThreshold(setting.thresholdMs)} is moved to the background (${source}).`
}

export const commands = {
    auto_background: (event, core) => {
        const access = loadAccess()
        if (!commandScope(event, core, access).allowed) { return { effects: [] } }

        const replyTo = replyToFromEvent(event, "cmd/auto_background")
        const key = autoBackgroundKey(event.chatId, event.threadId)
        const defaultMs = getSlowToolBackgroundMs()
        const arg = (event.text ?? "").replace(/^\/auto_background\s*/i, "").trim()

        if (arg.length === 0) {
            const setting = resolveAutoBackground(core.chatState, key, defaultMs)
            return { effects: [sendEffect(replyTo, describe(setting))] }
        }

        const parsed = parseAutoBackgroundArg(arg)
        if (parsed.error) {
            return { effects: [sendEffect(replyTo, parsed.error)] }
        }
        const nextState = { ...(core.chatState?.autoBackground ?? {}) }
        if (parsed.value === undefined) {
            delete nextState[key]
        } else {
            nextState[key] = parsed.value
        }
        const setting = resolveAutoBackground({ autoBackground: nextState }, key, defaultMs)
        return {
            stateChanges: { chatState: { autoBackground: { [key]: parsed.value } } },
            effects: [sendEffect(replyTo, describe(setting))],
        }
    },
}
