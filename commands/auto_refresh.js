// commands/auto_refresh.js — Action-returning hot command.
//
// Per-topic switch: with it on, a message sent to a topic whose session has
// gone stale (idle past its prompt-cache TTL, see lib/stale-chats.js) refreshes
// the topic first and hands the message to the new session. Off by default.
//
//   /auto_refresh       → show this topic's setting
//   /auto_refresh on    → refresh stale sessions before delivering my messages
//   /auto_refresh off   → deliver to the stale session as-is (default)
//
// Stored at chatState.autoRefresh[<chat>:<thread>] (only `true` is stored).

import { versionedImport } from "../lib/version.js"
const { loadAccess } = await versionedImport("../lib/access.js", import.meta)
const { commandScope } = await versionedImport("../lib/command-scope.js", import.meta)
const { replyToFromEvent, sendEffect } = await versionedImport("../lib/pure/reply-to.js", import.meta)
const { topicShellKey } = await versionedImport("../lib/pure/shell-cwd.js", import.meta)

export const tips = [
    "/auto_refresh on makes a message to a stale topic start a fresh session instead of re-reading the old context.",
]

export const descriptions = {
    auto_refresh: "Auto-/refresh this topic when you message it after it went stale (/auto_refresh on | off)",
}

function describe(enabled) {
    return enabled
        ? "Auto-refresh is *on* for this topic: a message after it goes stale starts a fresh session (topic memory carries over)."
        : "Auto-refresh is *off* for this topic: messages go to the existing session even when it's stale."
}

export const commands = {
    auto_refresh: (event, core) => {
        const access = loadAccess()
        const scope = commandScope(event, core, access)
        if (!scope.allowed) { return { effects: [] } }

        const replyTo = replyToFromEvent(event, "cmd/auto_refresh")
        if (!scope.isCommandCenter || !event.threadId) {
            return { effects: [sendEffect(replyTo, "/auto_refresh only works inside a command-center topic.")] }
        }
        const key = topicShellKey(event.chatId, event.threadId)
        const arg = (event.text ?? "").replace(/^\/auto_refresh(@\S+)?\s*/i, "").trim().toLowerCase()

        if (arg.length === 0) {
            return { effects: [sendEffect(replyTo, describe(core.chatState?.autoRefresh?.[key] === true))] }
        }
        if (arg !== "on" && arg !== "off") {
            return { effects: [sendEffect(replyTo, "Usage: /auto_refresh on | off")] }
        }
        const enabled = arg === "on"
        return {
            stateChanges: { chatState: { autoRefresh: { [key]: enabled ? true : undefined } } },
            effects: [sendEffect(replyTo, describe(enabled))],
        }
    },
}
