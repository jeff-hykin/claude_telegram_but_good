// commands/queue.js — Action-returning hot command.
//
// /que <message>      queues a message to be delivered to the session AFTER
//                     it finishes its current turn (Stop hook fires). FIFO.
// /que_first <message> same, but jumps to the FRONT of the queue.
// /que                (no args) shows the queue as YAML (copy → edit → /que_edit).
// /que_edit <yaml>    replaces the queue with a YAML list of message strings.
// /clear_que          empties the queue.
//
// Letting the user stack follow-up instructions without interrupting the agent
// mid-task. Messages drain one per turn.

import { parseYaml, stringifyYaml } from "../imports.js"
import { versionedImport } from "../lib/version.js"
const { loadAccess } = await versionedImport("../lib/access.js", import.meta)
const { dbg } = await versionedImport("../lib/logging.js", import.meta)
const { replyToFromEvent, sendEffect } = await versionedImport("../lib/pure/reply-to.js", import.meta)

export const tips = [
    "/que stacks messages (delivered one per turn). /que_first jumps the line. /que shows YAML; /que_edit <yaml> rewrites it.",
]

export const descriptions = {
    que: "Queue a message after the current turn (no args = show queue as YAML)",
    queue: "Queue a message after the current turn (no args = show queue as YAML)",
    que_first: "Queue a message at the FRONT of the queue",
    que_front: "Queue a message at the FRONT of the queue",
    que_edit: "Replace the queue with a YAML list of messages",
    clear_que: "Clear all queued messages for the current session",
    clear_queue: "Clear all queued messages for the current session",
}

// Shared access gate: command-center group, or an allowlisted DM. Returns true
// when the sender may operate on the queue.
function isAllowed(event, access, isCC) {
    if (event.chatType !== "private" && !isCC) { return false }
    if (!isCC && !access.allowFrom.includes(String(event.userId ?? ""))) { return false }
    return true
}

// Resolve which session's queue we're operating on: the session bound to the
// current CC topic, else the focused session.
function resolveTargetId(event, core, isCC) {
    if (isCC && event.threadId) {
        const cc = core.chatState?.commandCenter ?? {}
        const bound = cc.threadMap?.[String(event.threadId)] ?? null
        if (bound) { return bound }
    }
    return core.chatState?.focusedSessionId ?? null
}

// Build a fresh queue entry for `text`, routed back to this topic/chat.
function makeEntry(text, event) {
    return {
        text,
        chatId: event.chatId,
        messageId: event.messageId,
        threadId: event.threadId ?? null,
        queuedAt: Date.now(),
    }
}

// Add `body` to a session's queue at the front or back, returning the Action.
function enqueue(event, core, isCC, body, { front }) {
    const targetId = resolveTargetId(event, core, isCC)
    const replyTo = replyToFromEvent(event, front ? "cmd/que_first" : "cmd/que")
    if (!targetId) {
        return { effects: [sendEffect(replyTo, "No session to queue for.")] }
    }
    const existing = core.chatSessions?.[targetId]?.pendingQueue ?? []
    const entry = makeEntry(body, event)
    const newQueue = front ? [entry, ...existing] : [...existing, entry]
    dbg("QUE", `queued message for ${targetId} at ${front ? "front" : "back"} (${newQueue.length} pending)`)
    const where = front ? "at front " : ""
    return {
        stateChanges: { chatSessions: { [targetId]: { pendingQueue: newQueue } } },
        effects: [sendEffect(replyTo, `Queued ${where}(${newQueue.length} pending). Will deliver after the agent finishes.`)],
    }
}

// Render the queue as a YAML list of message strings, wrapped in a code fence
// so it's monospace + copy-friendly for /que_edit.
function showQueueYaml(event, core, isCC) {
    const replyTo = replyToFromEvent(event, "cmd/que")
    const targetId = resolveTargetId(event, core, isCC)
    const pending = (targetId ? core.chatSessions?.[targetId]?.pendingQueue : null) ?? []
    const yaml = pending.length ? stringifyYaml(pending.map(entry => entry.text)) : "[]\n"
    const text = `*Queue (${pending.length}):*\n\`\`\`yaml\n${yaml}\`\`\``
    return { effects: [sendEffect(replyTo, text, { parse_mode: "Markdown" })] }
}

export const commands = {
    que: (event, core) => {
        const access = loadAccess()
        const isCC = String(event.chatId) === String(access.commandCenterChatId ?? "")
        if (!isAllowed(event, access, isCC)) { return { effects: [] } }

        const body = (event.text ?? "").replace(/^\/que(?:ue)?\s*/i, "").trim()
        if (!body) { return showQueueYaml(event, core, isCC) }

        // /que ALWAYS queues. The earlier "deliver immediately when idle"
        // behavior fought the user's mental model: even when the agent had
        // just Stop'd seconds ago, the user types /que because they're
        // continuing a conversation and expect the message to wait. If the
        // queue ever strands on a permanently-idle session, the user can drain
        // it with /clear_que or just send a regular (non-/que) message.
        return enqueue(event, core, isCC, body, { front: false })
    },

    que_first: (event, core) => {
        const access = loadAccess()
        const isCC = String(event.chatId) === String(access.commandCenterChatId ?? "")
        if (!isAllowed(event, access, isCC)) { return { effects: [] } }

        const replyTo = replyToFromEvent(event, "cmd/que_first")
        const body = (event.text ?? "").replace(/^\/que_(?:first|front)\s*/i, "").trim()
        if (!body) {
            return { effects: [sendEffect(replyTo, "Usage: /que_first <message> — adds to the front of the queue.")] }
        }
        return enqueue(event, core, isCC, body, { front: true })
    },

    que_edit: (event, core) => {
        const access = loadAccess()
        const isCC = String(event.chatId) === String(access.commandCenterChatId ?? "")
        if (!isAllowed(event, access, isCC)) { return { effects: [] } }

        const replyTo = replyToFromEvent(event, "cmd/que_edit")
        // Strip the command word and any ```yaml fence the user copied back.
        let raw = (event.text ?? "").replace(/^\/que_edit\s*/i, "")
        raw = raw.replace(/^```(?:yaml)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim()
        if (!raw) {
            return { effects: [sendEffect(replyTo, "Usage: /que_edit <yaml list of messages>. Run /que to get the current YAML.")] }
        }

        const targetId = resolveTargetId(event, core, isCC)
        if (!targetId) {
            return { effects: [sendEffect(replyTo, "No session to edit the queue for.")] }
        }

        let parsed
        try {
            parsed = parseYaml(raw)
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            return { effects: [sendEffect(replyTo, `Could not parse YAML: ${msg}`)] }
        }
        if (!Array.isArray(parsed)) {
            return { effects: [sendEffect(replyTo, "Expected a YAML list of messages (e.g. `- do the thing`).")] }
        }

        // Coerce each item to a non-empty string; drop blanks.
        const texts = parsed
            .map(item => (item == null ? "" : String(item)).trim())
            .filter(Boolean)
        const newQueue = texts.map(text => makeEntry(text, event))

        dbg("QUE", `que_edit replaced queue for ${targetId} → ${newQueue.length} item(s)`)
        return {
            stateChanges: { chatSessions: { [targetId]: { pendingQueue: newQueue } } },
            effects: [sendEffect(replyTo, `Queue replaced — ${newQueue.length} item(s).`)],
        }
    },

    clear_que: (event, core) => {
        const access = loadAccess()
        const isCC = String(event.chatId) === String(access.commandCenterChatId ?? "")
        if (!isAllowed(event, access, isCC)) { return { effects: [] } }

        const replyTo = replyToFromEvent(event, "cmd/clear_que")
        const targetId = resolveTargetId(event, core, isCC)
        if (!targetId) { return { effects: [sendEffect(replyTo, "No session.")] } }

        const cleared = (core.chatSessions?.[targetId]?.pendingQueue ?? []).length
        dbg("QUE", `cleared ${cleared} queued messages for ${targetId}`)
        return {
            stateChanges: { chatSessions: { [targetId]: { pendingQueue: [] } } },
            effects: [sendEffect(replyTo, cleared > 0 ? `Cleared ${cleared} queued message(s).` : "Queue was already empty.")],
        }
    },
}

// Aliases
commands.queue = commands.que
commands.que_front = commands.que_first
commands.clear_queue = commands.clear_que
