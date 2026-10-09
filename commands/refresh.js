// commands/refresh.js — Action-returning hot command.
//
// Spawns a new agent session in the current topic, binding it to the
// topic and feeding the last 50 messages as context.

import { versionedImport } from "../lib/version.js"
const { loadAccess } = await versionedImport("../lib/access.js", import.meta)
const { resolveRefreshTarget } = await versionedImport("../lib/refresh-target.js", import.meta)
const { commandScope } = await versionedImport("../lib/command-scope.js", import.meta)
const { groupHandoffPrompt } = await versionedImport("../lib/listen-mode.js", import.meta)
const { dbg } = await versionedImport("../lib/logging.js", import.meta)
const { generateName } = await versionedImport("../lib/pure/ids.js", import.meta)
const { prepareTopicHandoff } = await versionedImport("../lib/topic-context.js", import.meta)
const { replyToFromEvent, sendEffect } = await versionedImport("../lib/pure/reply-to.js", import.meta)
const { DEFAULT_BACKEND_NAME, defaultBackend, getBackend } = await versionedImport("../lib/agent-backends/index.js", import.meta)

export const descriptions = {
    refresh: "Spawn a new session in this topic",
}


export const commands = {
    refresh: async (event, core) => {
        const access = loadAccess()
        const replyTo = replyToFromEvent(event, "cmd/refresh")

        // chat-user already refuses a non-allowlisted sender's slash
        // command in a group chat, but /refresh spawns a session and
        // retires one — it states its own authorization rather than
        // inheriting the dispatcher's.
        if (!commandScope(event, core, access).allowed) { return { effects: [] } }

        const target = resolveRefreshTarget(event, core, access)
        if (target.error) {
            return { effects: [sendEffect(replyTo, target.error, { parse_mode: "Markdown" })] }
        }
        const { chatKey, threadKey, title, sessionTitle, existingSessionId } = target
        const isGroupChat = target.kind === "groupChat"

        const cc = core.chatState?.commandCenter ?? {}
        const oldSession = existingSessionId ? core.chatSessions?.[existingSessionId] : null
        const savedBackend = isGroupChat
            ? core.chatState?.groupChatSessions?.[chatKey]?.backend
            : cc.topicBackends?.[threadKey]
        const backend = oldSession ? (oldSession.backend ?? DEFAULT_BACKEND_NAME) : (savedBackend ?? defaultBackend().name)
        const health = await getBackend(backend).healthCheck()
        if (!health.ok) {
            return { effects: [sendEffect(replyTo, `The ${backend} backend isn't usable right now: ${health.detail}`)] }
        }
        const sessionId = generateName()

        try {
            const handoff = prepareTopicHandoff({ sessionId, title, oldSessionId: existingSessionId })

            const effects = [
                { type: "spawn_dtach_session", sessionId, title: sessionTitle, topicName: title, backend },
                sendEffect(replyTo, `Spawned new session \`${sessionId}\` (${sessionTitle})${handoff.note}`, { parse_mode: "Markdown" }),
            ]

            // Kill old session: send /exit gracefully, then schedule a
            // force-close as fallback in case it doesn't exit cleanly.
            if (existingSessionId) {
                const oldSession = core.chatSessions?.[existingSessionId]
                if (oldSession) {
                    if (backend === DEFAULT_BACKEND_NAME) {
                        effects.push({
                            type: "send_text_to_claude",
                            sessionId: existingSessionId,
                            text: "/exit",
                        })
                    }
                    effects.push({
                        type: "set_timer",
                        delayMs: backend === DEFAULT_BACKEND_NAME ? 15000 : 0,
                        event: {
                            type: "session_force_close",
                            sessionId: existingSessionId,
                        },
                    })
                    dbg("REFRESH", `killing old session ${existingSessionId}`)
                }
            }

            // Queue context as a channel message so it's delivered
            // through the event queue when the session registers and
            // becomes focused — no dtach race with user messages.
            const messageQueue = [...(core.chatState?.messageQueue ?? [])]

            if (isGroupChat) {
                // A group session replaces one that was listening, so it
                // starts silent too, and is told the listening rules
                // rather than "ask how you can help". Focus is left alone:
                // the handoff is targeted, and a group chat should not
                // steal the operator's focused session.
                messageQueue.push({
                    content: groupHandoffPrompt(sessionTitle, handoff),
                    meta: { source: "group-listen-context" },
                    queuedAt: Date.now(),
                    targetSessionId: sessionId,
                })
                dbg("REFRESH", `queued group handoff for ${sessionId} (topic ${title})${handoff.note}`)
                return {
                    stateChanges: {
                        chatState: {
                            messageQueue,
                            groupChatSessions: {
                                [chatKey]: { sessionId, spawnedAt: Date.now(), topicName: title, backend },
                            },
                        },
                        chatSessions: {
                            [sessionId]: {
                                id: sessionId,
                                title: sessionTitle,
                                backend,
                                listenMode: true,
                                listenChatId: chatKey,
                            },
                        },
                    },
                    effects,
                }
            }

            // Update topic maps
            const topicMap = { ...(cc.topicMap ?? {}) }
            const threadMap = { ...(cc.threadMap ?? {}) }
            const topicNames = { ...(cc.topicNames ?? {}) }

            // Unbind old session if any
            if (existingSessionId) {
                delete topicMap[existingSessionId]
            }

            topicMap[sessionId] = threadKey
            threadMap[threadKey] = sessionId
            topicNames[threadKey] = title

            messageQueue.push({
                content: handoff.prompt,
                targetSessionId: sessionId,
                meta: { source: "refresh-context" },
                queuedAt: Date.now(),
            })
            dbg("REFRESH", `queued handoff for ${sessionId}${handoff.note}`)

            return {
                stateChanges: {
                    chatState: {
                        pendingFocusId: sessionId,
                        messageQueue,
                        commandCenter: {
                            ...cc,
                            topicMap,
                            threadMap,
                            topicNames,
                            topicBackends: { ...(cc.topicBackends ?? {}), [threadKey]: backend },
                        },
                    },
                },
                effects,
            }
        } catch (err) {
            let detail = ""
            if (err instanceof Error) {
                detail = err.message
                if (err.stderr) { detail += `\nstderr: ${err.stderr}` }
                if (err.stdout) { detail += `\nstdout: ${err.stdout}` }
            } else {
                detail = String(err)
            }
            dbg("REFRESH", "failed:", detail)
            return { effects: [sendEffect(replyTo, `Failed to spawn session:\n${detail}`, { parse_mode: "Markdown" })] }
        }
    },
}
