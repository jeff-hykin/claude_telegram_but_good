/**
 * lib/memory-hooks.js — keyword-triggered reminders.
 *
 * A memory hook pairs a PATTERN with a HINT. Whenever the pattern shows up
 * in text the agent is about to act on, the hint is put in front of the
 * agent. It exists so a fact that is easy to forget ("jeff doesn't attend
 * Manipulation Weekly") gets re-stated at exactly the moment it matters,
 * instead of relying on someone having read it earlier.
 *
 * Three trigger points, all matching against the same rule list:
 *   - a USER message      → the hint is appended to the text the agent receives
 *   - an agent REPLY      → the reply is rejected and the hint handed back, so
 *                           a wrong statement is corrected before it is sent
 *   - an agent TOOL call  → the hint is nudged into the session
 *
 * Rules live as plain JSON at $CBG_DIR/memory-hooks.json, hand-editable, read
 * fresh on every call so edits take effect without a reload.
 */

import { join } from "../imports.js"
import { versionedImport } from "./version.js"

const { dbg } = await versionedImport("./logging.js", import.meta)
const { paths } = await versionedImport("./paths.js", import.meta)

// A rule fires against agent output, which can be a whole file or a
// multi-megabyte command dump. Matching is capped so a pathological
// pattern can't stall the single-threaded daemon on a huge string.
const MAX_MATCH_CHARS = 20000

// A hint is meant to be a sentence, not a document — it gets injected into
// the agent's context on every fire.
export const MAX_HINT_CHARS = 500

const VALID_TRIGGERS = new Set(["user", "agent", "both"])

function hooksPath() {
    return join(paths.CBG_DIR, "memory-hooks.json")
}

export function loadHooks() {
    let raw
    try {
        raw = JSON.parse(Deno.readTextFileSync(hooksPath()))
    } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) {
            dbg("MEMORY-HOOKS", "failed to load hooks:", e)
        }
        return []
    }
    if (!Array.isArray(raw)) {
        dbg("MEMORY-HOOKS", "hooks file is not an array — ignoring it")
        return []
    }
    return raw.filter((hook) =>
        hook
        && typeof hook.pattern === "string" && hook.pattern.length > 0
        && typeof hook.hint === "string" && hook.hint.length > 0
    )
}

export function saveHooks(hooks) {
    Deno.writeTextFileSync(hooksPath(), `${JSON.stringify(hooks, null, 4)}\n`)
}

export function newHookId() {
    return `mh${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Turn a rule's pattern into a RegExp. `/foo/i` is taken as a regex;
 * anything else is a literal, case-insensitively matched anywhere in the
 * text (so "dimos" still fires on "dimos3"). A pattern that won't compile
 * is dropped rather than thrown, so one bad rule can't take down every
 * message that passes through the matcher.
 */
export function compilePattern(pattern) {
    const asRegex = /^\/(.+)\/([gimsuy]*)$/s.exec(pattern)
    try {
        if (asRegex) {
            // `g` is stripped: lastIndex on a shared regex makes repeated
            // .test() calls alternate between hit and miss.
            return new RegExp(asRegex[1], asRegex[2].replace(/g/g, ""))
        }
        return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
    } catch (e) {
        dbg("MEMORY-HOOKS", `pattern ${pattern} won't compile:`, e)
        return null
    }
}

/**
 * Every hook whose pattern appears in `text`.
 *
 * @param trigger  "user" or "agent" — a rule only fires on the side its
 *                 own `on` field allows ("both" by default).
 * @param excludeIds  ids that already fired this turn, so the agent isn't
 *                 told the same thing twice while it works on one message.
 */
export function matchHooks(text, trigger, excludeIds = []) {
    if (typeof text !== "string" || text.length === 0) {
        return []
    }
    const haystack = text.slice(0, MAX_MATCH_CHARS)
    const skip = new Set(excludeIds)
    const matched = []
    for (const hook of loadHooks()) {
        if (hook.id && skip.has(hook.id)) {
            continue
        }
        const on = VALID_TRIGGERS.has(hook.on) ? hook.on : "both"
        if (on !== "both" && on !== trigger) {
            continue
        }
        const regex = compilePattern(hook.pattern)
        if (regex && regex.test(haystack)) {
            matched.push(hook)
        }
    }
    return matched
}

/**
 * The block appended to a user message on its way to the agent. Tagged so
 * the agent can tell a remembered note from something the user just typed.
 */
export function formatHintBlock(hooks) {
    if (hooks.length === 0) {
        return ""
    }
    return hooks
        .map((hook) => `<memory_hint keyword="${hook.pattern}">${hook.hint}</memory_hint>`)
        .join("\n")
}

/**
 * What the agent is told when one of its own replies trips a hook. It has
 * to say the reply was dropped, or the agent assumes the message went out
 * and moves on without re-sending.
 */
export function replyBlockText(hooks) {
    const hints = hooks.map((hook) => `- ${hook.hint} (remembered for "${hook.pattern}")`).join("\n")
    return `Your reply was NOT sent. It mentions something you have a standing note about:\n\n${hints}\n\n` +
        `Re-read your message against that note, correct it if it's wrong, and call reply again. ` +
        `If the note doesn't change anything, send the same message again — it will go through this time.`
}

/**
 * What gets nudged into a session when a tool call trips a hook. The agent
 * is mid-turn here, so it reads as an interjection rather than a rejection.
 */
export function toolHintText(hooks) {
    const hints = hooks.map((hook) => `- ${hook.hint} (remembered for "${hook.pattern}")`).join("\n")
    return `[memory hook] Something you just did matches a standing note:\n\n${hints}`
}

/**
 * The pre/post-tool-use half of the agent trigger, shared by both hook
 * handlers because the only thing that differs between them is which
 * previews exist. Returns the session patch and effects to fold into the
 * handler's Action, or null when nothing tripped.
 */
export function toolHookAction(session, sessionId, texts) {
    const alreadyFired = session?.memoryHooksFired ?? []
    const haystack = texts.filter((text) => typeof text === "string" && text.length > 0).join("\n")
    const tripped = matchHooks(haystack, "agent", alreadyFired)
    if (tripped.length === 0) {
        return null
    }
    dbg("MEMORY-HOOKS", `${sessionId} tripped ${tripped.map((hook) => hook.pattern).join(", ")}`)
    return {
        patch: {
            memoryHooksFired: [...alreadyFired, ...tripped.map((hook) => hook.id).filter(Boolean)],
        },
        effects: [{ type: "send_text_to_claude", sessionId, text: toolHintText(tripped) }],
    }
}

/**
 * Parse `<pattern> <hint>` out of a command's argument text.
 *
 * A `/regex/flags` pattern is delimited by its own closing slash; a bare
 * keyword is the first whitespace-separated token. Either form takes an
 * optional comma before the hint, because that reads naturally:
 *     /memory_hook /Manipulation Weekly/, jeff doesn't attend that
 *     /memory_hook dimos if uncertain, see jhist
 */
export function parseHookArgs(text) {
    const trimmed = (text ?? "").trim()
    if (trimmed.length === 0) {
        return null
    }

    let pattern = null
    let rest = null
    const asRegex = /^(\/(?:[^/\\]|\\.)+\/[gimsuy]*)([\s\S]*)$/.exec(trimmed)
    if (asRegex) {
        pattern = asRegex[1]
        rest = asRegex[2]
    } else {
        const spaceIndex = trimmed.search(/\s/)
        if (spaceIndex < 0) {
            return null
        }
        pattern = trimmed.slice(0, spaceIndex)
        rest = trimmed.slice(spaceIndex)
    }

    const hint = rest.replace(/^\s*,?\s*/, "").trim()
    if (pattern.length === 0 || hint.length === 0) {
        return null
    }
    return { pattern, hint: hint.slice(0, MAX_HINT_CHARS) }
}

/**
 * Add a hook, or update the hint of an existing one with the same pattern.
 * Shared by the chat command and the MCP tool so both validate identically.
 */
export function addHook({ pattern, hint, on }) {
    if (typeof pattern !== "string" || pattern.trim().length === 0) {
        return { error: "pattern is required" }
    }
    if (typeof hint !== "string" || hint.trim().length === 0) {
        return { error: "hint is required" }
    }
    if (!compilePattern(pattern.trim())) {
        return { error: `pattern ${pattern} is not a valid regex` }
    }

    const hooks = loadHooks()
    const cleaned = {
        pattern: pattern.trim(),
        hint: hint.trim().slice(0, MAX_HINT_CHARS),
        on: VALID_TRIGGERS.has(on) ? on : "both",
    }
    const existing = hooks.findIndex((hook) => hook.pattern === cleaned.pattern)
    if (existing >= 0) {
        const updated = { ...hooks[existing], ...cleaned }
        hooks[existing] = updated
        saveHooks(hooks)
        return { hook: updated, updated: true, total: hooks.length }
    }

    const hook = { id: newHookId(), createdAt: new Date().toISOString(), ...cleaned }
    hooks.push(hook)
    saveHooks(hooks)
    return { hook, updated: false, total: hooks.length }
}

/**
 * Remove by id, or by exact pattern so a hook is removable straight from
 * the text that created it.
 */
export function removeHook(idOrPattern) {
    const hooks = loadHooks()
    const index = hooks.findIndex((hook) => hook.id === idOrPattern || hook.pattern === idOrPattern)
    if (index < 0) {
        return { error: `no memory hook matching "${idOrPattern}"` }
    }
    const [removed] = hooks.splice(index, 1)
    saveHooks(hooks)
    return { hook: removed, total: hooks.length }
}
