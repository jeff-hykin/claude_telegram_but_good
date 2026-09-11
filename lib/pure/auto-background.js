// ---------------------------------------------------------------------------
// lib/pure/auto-background.js
//
// The per-topic switch for the slow-tool watchdog (lib/event-handlers/
// slow-tool-check.js). On by default. A topic opts out, or sets its own
// threshold, through `/auto_background` (commands/auto_background.js),
// which stores:
//
//   chatState.autoBackground[<chatId>:<threadId>] = { enabled?: false, thresholdMs?: number }
//
// Only overrides are stored — an absent entry means "on, at the config
// default". The key is the same `topicShellKey` the `#` shell uses, so
// "this topic" means the same thing everywhere.
// ---------------------------------------------------------------------------

import { topicShellKey } from "./shell-cwd.js"
import { replyToForSession } from "./reply-to.js"

/** Key for the topic a command was typed in. */
export function autoBackgroundKey(chatId, threadId) {
    return topicShellKey(chatId, threadId)
}

/** Key for the topic a SESSION belongs to, or null if it has no chat. */
export function autoBackgroundKeyForSession(sessionId, core) {
    const { chatId, threadId } = replyToForSession(sessionId, core, "auto-background")
    if (!chatId) {
        return null
    }
    return topicShellKey(chatId, threadId)
}

/**
 * Resolve the effective setting for a key.
 *
 * @param {object} chatState
 * @param {string|null} key
 * @param {number} defaultThresholdMs — from config (slow_tool_background_ms)
 * @returns {{ enabled: boolean, thresholdMs: number, overridden: boolean }}
 */
export function resolveAutoBackground(chatState, key, defaultThresholdMs) {
    const entry = key ? chatState?.autoBackground?.[key] : null
    const thresholdMs = Number.isFinite(entry?.thresholdMs) && entry.thresholdMs > 0
        ? entry.thresholdMs
        : defaultThresholdMs
    return {
        enabled: entry?.enabled !== false,
        thresholdMs,
        overridden: entry != null,
    }
}

/**
 * Parse the argument of `/auto_background`. Returns the chatState patch
 * value for the key (undefined = clear the override), or an error string.
 *
 *   "on"        → undefined (back to the default: on, config threshold)
 *   "off"       → { enabled: false }
 *   "30" / "30s" → { thresholdMs: 30000 }
 *   "2m"        → { thresholdMs: 120000 }
 */
export function parseAutoBackgroundArg(arg) {
    const a = String(arg ?? "").trim().toLowerCase()
    if (a === "on") {
        return { value: undefined }
    }
    if (a === "off") {
        return { value: { enabled: false } }
    }
    const m = /^(\d+(?:\.\d+)?)\s*(s|sec|m|min)?$/.exec(a)
    if (!m) {
        return { error: "Usage: /auto_background on | off | <seconds> (e.g. 30, 45s, 2m)" }
    }
    const n = Number(m[1])
    const unit = m[2] ?? "s"
    const thresholdMs = Math.round(n * (unit.startsWith("m") ? 60_000 : 1_000))
    if (!(thresholdMs > 0)) {
        return { error: "Threshold must be greater than zero." }
    }
    return { value: { thresholdMs } }
}

export function formatThreshold(ms) {
    if (ms % 60_000 === 0) {
        return `${ms / 60_000}m`
    }
    return `${Math.round(ms / 100) / 10}s`
}
