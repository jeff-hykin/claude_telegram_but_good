// commands/queue.js — Action-returning hot command.
//
// /que <message> queues a message to be delivered to the session AFTER
// it finishes its current turn (Stop hook fires). This lets the user
// stack up follow-up instructions without interrupting the agent
// mid-task. The queue is FIFO — messages are drained one per turn.

import { versionedImport } from "../lib/version.js"
const { loadAccess } = await versionedImport("../lib/access.js", import.meta)
const { dbg } = await versionedImport("../lib/logging.js", import.meta)
const { escapeHtml: esc } = await versionedImport("../lib/pure/html.js", import.meta)
const { sendEffect } = await versionedImport("../lib/pure/reply-to.js", import.meta)

export const tips = [
    "/que lets you stack messages — they're delivered one at a time after the agent finishes each turn.",
]

export const descriptions = {
    que: "Queue a message to send after the agent finishes its current turn",
    queue: "Queue a message to send after the agent finishes its current turn",
    clear_que: "Clear all queued messages for the current session",
    clear_queue: "Clear all queued messages for the current session",
}

export const commands = {
    que: (event, core) => {
        const access = loadAccess()
        const isCC = String(event.chatId) === String(access.commandCenterChatId ?? "")
        if (event.chatType !== "private" && !isCC) { return { effects: [] } }
        if (!isCC && !access.allowFrom.includes(String(event.userId ?? ""))) {
            return { effects: [] }
        }

        const body = (event.text ?? "").replace(/^\/que(?:ue)?\s*/i, "").trim()
        if (!body) {
            // No message — show current queue
            let targetId = null
            if (isCC && event.threadId) {
                const cc = core.chatState?.commandCenter ?? {}
                targetId = cc.threadMap?.[String(event.threadId)] ?? null
            }
            if (!targetId) { targetId = core.chatState?.focusedSessionId }
            const session = targetId ? core.chatSessions?.[targetId] : null
            const pending = session?.pendingQueue ?? []
            if (pending.length === 0) {
                return {
                    effects: [sendEffect(event.replyTo, "Queue is empty. Use <code>/que &lt;message&gt;</code> to add one.", { parse_mode: "HTML" })],
                }
            }
            const lines = [`<b>Queued messages (${pending.length}):</b>`]
            for (let i = 0; i < pending.length; i++) {
                lines.push(`${i + 1}. ${esc(pending[i].text.slice(0, 100))}`)
            }
            return {
                effects: [sendEffect(event.replyTo, lines.join("\n"), { parse_mode: "HTML" })],
            }
        }

        // Resolve target session
        let targetId = null
        if (isCC && event.threadId) {
            const cc = core.chatState?.commandCenter ?? {}
            targetId = cc.threadMap?.[String(event.threadId)] ?? null
            if (targetId) {
                dbg("QUE", `CC topic ${event.threadId} → session ${targetId}`)
            }
        }
        if (!targetId) { targetId = core.chatState?.focusedSessionId }

        if (!targetId) {
            return {
                effects: [sendEffect(event.replyTo, "No session to queue for.")],
            }
        }

        const session = core.chatSessions?.[targetId]
        const existing = session?.pendingQueue ?? []
        const entry = {
            text: body,
            chatId: event.chatId,
            messageId: event.messageId,
            threadId: event.threadId ?? null,
            queuedAt: Date.now(),
        }
        const newQueue = [...existing, entry]

        dbg("QUE", `queued message for ${targetId} (${newQueue.length} pending)`)

        return {
            stateChanges: {
                chatSessions: {
                    [targetId]: { pendingQueue: newQueue },
                },
            },
            effects: [sendEffect(event.replyTo, `Queued (${newQueue.length} pending). Will deliver after the agent finishes.`)],
        }
    },
}

// Alias /queue → /que
commands.queue = commands.que

commands.clear_que = (event, core) => {
    const access = loadAccess()
    const isCC = String(event.chatId) === String(access.commandCenterChatId ?? "")
    if (event.chatType !== "private" && !isCC) { return { effects: [] } }
    if (!isCC && !access.allowFrom.includes(String(event.userId ?? ""))) {
        return { effects: [] }
    }

    let targetId = null
    if (isCC && event.threadId) {
        const cc = core.chatState?.commandCenter ?? {}
        targetId = cc.threadMap?.[String(event.threadId)] ?? null
    }
    if (!targetId) { targetId = core.chatState?.focusedSessionId }

    if (!targetId) {
        return { effects: [sendEffect(event.replyTo, "No session.")] }
    }

    const session = core.chatSessions?.[targetId]
    const cleared = (session?.pendingQueue ?? []).length

    dbg("QUE", `cleared ${cleared} queued messages for ${targetId}`)

    return {
        stateChanges: {
            chatSessions: {
                [targetId]: { pendingQueue: [] },
            },
        },
        effects: [sendEffect(event.replyTo, cleared > 0 ? `Cleared ${cleared} queued message(s).` : "Queue was already empty.")],
    }
}
commands.clear_queue = commands.clear_que
