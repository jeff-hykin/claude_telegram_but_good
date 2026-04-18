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

export const tips = [
    "/que lets you stack messages — they're delivered one at a time after the agent finishes each turn.",
]

export const descriptions = {
    que: "Queue a message to send after the agent finishes its current turn",
    queue: "Queue a message to send after the agent finishes its current turn",
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
            const options = {}
            if (event.threadId != null) { options.message_thread_id = Number(event.threadId) }

            if (pending.length === 0) {
                return {
                    effects: [{
                        type: "send_text_to_user",
                        chatId: event.chatId,
                        text: "Queue is empty. Use <code>/que &lt;message&gt;</code> to add one.",
                        options: { parse_mode: "HTML", ...options },
                    }],
                }
            }
            const lines = [`<b>Queued messages (${pending.length}):</b>`]
            for (let i = 0; i < pending.length; i++) {
                lines.push(`${i + 1}. ${esc(pending[i].text.slice(0, 100))}`)
            }
            return {
                effects: [{
                    type: "send_text_to_user",
                    chatId: event.chatId,
                    text: lines.join("\n"),
                    options: { parse_mode: "HTML", ...options },
                }],
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
            const options = {}
            if (event.threadId != null) { options.message_thread_id = Number(event.threadId) }
            return {
                effects: [{
                    type: "send_text_to_user",
                    chatId: event.chatId,
                    text: "No session to queue for.",
                    options,
                }],
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

        const options = {}
        if (event.threadId != null) { options.message_thread_id = Number(event.threadId) }
        return {
            stateChanges: {
                chatSessions: {
                    [targetId]: { pendingQueue: newQueue },
                },
            },
            effects: [{
                type: "send_text_to_user",
                chatId: event.chatId,
                text: `Queued (${newQueue.length} pending). Will deliver after the agent finishes.`,
                options,
            }],
        }
    },
}

// Alias /queue → /que
commands.queue = commands.que
