// commands/backend.js — move a topic to a different agent backend.
//
// A backend is chosen at spawn time and a running session cannot change
// its own, so switching means replacing the session: spawn a new one on
// the requested backend, rebind the topic to it, hand it the same topic
// memory + conversation tail /refresh would, and retire the old one.
//
// Named /backend rather than /switch_backend because lib/event-handlers/
// chat-user.js routes `/switch_<name>` to a SESSION named <name> — a
// /switch_backend would be read as "focus the session called backend".

import { versionedImport } from "../lib/version.js"
const { loadAccess } = await versionedImport("../lib/access.js", import.meta)
const { dbg } = await versionedImport("../lib/logging.js", import.meta)
const { generateName } = await versionedImport("../lib/pure/ids.js", import.meta)
const { listBackends, getBackend, DEFAULT_BACKEND_NAME } = await versionedImport("../lib/agent-backends/index.js", import.meta)
const { prepareTopicHandoff } = await versionedImport("../lib/topic-context.js", import.meta)
const { replyToFromEvent, sendEffect } = await versionedImport("../lib/pure/reply-to.js", import.meta)

export const descriptions = {
    backend: "Show or switch this topic's agent (claude / codex / local)",
}

export const tips = [
    "/backend codex drives this topic with Codex instead of Claude",
]

export const commands = {
    backend: async (event, core) => {
        const access = loadAccess()
        const ccChatId = access.commandCenterChatId
        const replyTo = replyToFromEvent(event, "cmd/backend")

        if (!ccChatId || String(event.chatId) !== String(ccChatId)) {
            return { effects: [sendEffect(replyTo, "This command only works in the command center group.", { parse_mode: "Markdown" })] }
        }
        if (!event.threadId) {
            return { effects: [sendEffect(replyTo, "This command must be used inside a topic.", { parse_mode: "Markdown" })] }
        }

        const cc = core.chatState?.commandCenter ?? {}
        const threadKey = String(event.threadId)
        const oldSessionId = cc.threadMap?.[threadKey] ?? null
        const oldSession = oldSessionId ? core.chatSessions?.[oldSessionId] : null
        const currentName = oldSession?.backend ?? DEFAULT_BACKEND_NAME

        const names = listBackends().map(b => b.name)
        const wanted = (event.text ?? "").replace(/^\/backend\S*\s*/, "").trim().toLowerCase()

        if (!wanted) {
            const listed = names.map(n => (n === currentName ? `*${n}* (current)` : n)).join(", ")
            return { effects: [sendEffect(replyTo, `This topic runs on *${currentName}*.\nAvailable: ${listed}\n\nSwitch with \`/backend <name>\`.`, { parse_mode: "Markdown" })] }
        }
        if (!names.includes(wanted)) {
            return { effects: [sendEffect(replyTo, `Unknown backend "${wanted}". Available: ${names.join(", ")}`, { parse_mode: "Markdown" })] }
        }
        if (wanted === currentName && oldSession) {
            return { effects: [sendEffect(replyTo, `This topic is already on *${wanted}*. Use /refresh to restart it.`, { parse_mode: "Markdown" })] }
        }

        const backend = getBackend(wanted)
        const health = await backend.healthCheck()
        if (!health.ok) {
            return { effects: [sendEffect(replyTo, `The *${wanted}* backend isn't usable right now:\n${health.detail}`, { parse_mode: "Markdown" })] }
        }

        const title = cc.topicNames?.[threadKey] || oldSession?.title || `Topic${threadKey}`
        const sessionId = generateName()
        const handoff = prepareTopicHandoff({ sessionId, title, oldSessionId })

        const effects = [
            {
                type: "spawn_dtach_session",
                sessionId,
                title,
                topicName: title,
                backend: wanted,
            },
            sendEffect(replyTo, `Switched this topic to *${wanted}* — session \`${sessionId}\`.${handoff.note}`, { parse_mode: "Markdown" }),
        ]
        const followUpEvents = []

        if (oldSession) {
            // Only Claude reads "/exit" as a command. Any other backend
            // would take it as a literal user message and answer it, so
            // those go straight to the SIGTERM path.
            if (currentName === DEFAULT_BACKEND_NAME) {
                effects.push({ type: "send_text_to_claude", sessionId: oldSessionId, text: "/exit" })
                effects.push({ type: "set_timer", delayMs: 15000, event: { type: "session_force_close", sessionId: oldSessionId } })
            } else {
                followUpEvents.push({ type: "session_force_close", sessionId: oldSessionId })
            }
            dbg("BACKEND-CMD", `retiring ${currentName} session ${oldSessionId} for ${wanted} session ${sessionId}`)
        }

        const topicMap = { ...(cc.topicMap ?? {}) }
        const threadMap = { ...(cc.threadMap ?? {}) }
        const topicNames = { ...(cc.topicNames ?? {}) }
        if (oldSessionId) { delete topicMap[oldSessionId] }
        topicMap[sessionId] = threadKey
        threadMap[threadKey] = sessionId
        topicNames[threadKey] = title

        // Targeted at the new session rather than "whoever gets focus",
        // so an unrelated session registering first cannot swallow this
        // topic's handoff.
        const messageQueue = [...(core.chatState?.messageQueue ?? [])]
        messageQueue.push({
            content: handoff.prompt,
            targetSessionId: sessionId,
            meta: { source: "refresh-context" },
            queuedAt: Date.now(),
        })

        return {
            stateChanges: {
                chatState: {
                    pendingFocusId: sessionId,
                    messageQueue,
                    commandCenter: { ...cc, topicMap, threadMap, topicNames },
                },
            },
            effects,
            followUpEvents,
        }
    },
}
