// ---------------------------------------------------------------------------
// Handler for `chat_user_message` events.
//
// Dispatcher for user-sent chat messages, regardless of which platform
// (Telegram, Discord, …) produced them. The originating platform's
// translator module (lib/pure/telegram-translator.js or equivalent)
// normalizes its native ctx into a `chat_user_message` event before
// enqueuing. This handler only cares about the normalized shape.
//
// Handles:
//   1. Allowlist gating (plain text only; commands self-gate so public
//      commands like /start and /help reach unpaired users).
//   2. Dynamic regex commands (/switch_<id>, /chat_<id>, /task_*_<id>).
//   3. Hot-reloadable commands via dispatchHotCommand() — commands live
//      under commands/ and return Actions of their own, which we merge
//      into the surrounding Action via the `wrap` helper below.
//   4. Plain text → deliver to focused session via channel_event.
//
// Returns an Action; the event-loop dispatcher applies it.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { escapeHtml: esc } = await versionedImport("../pure/html.js", import.meta)
const { generateName, randomHex } = await versionedImport("../pure/ids.js", import.meta)
const { getHotCommands } = await versionedImport("../hot-commands.js", import.meta)
const { loadAccess } = await versionedImport("../access.js", import.meta)
const { buildRecordPatch } = await versionedImport("../effects/telegram-state.js", import.meta)
const { paths } = await versionedImport("../paths.js", import.meta)
const { buildCancelAction, taskCommandLinks, generateUniqueTaskId } = await versionedImport("../long-task-actions.js", import.meta)
const { buildScheduleCancelAction, scheduleCommandLinks, findScheduledTask } = await versionedImport("../scheduled-task-actions.js", import.meta)

/**
 * Dispatch a /command by looking it up in the hot-command registry
 * and awaiting its returned Action. Catches thrown errors and
 * returns an error-stash Action (same shape the legacy runHotCommand
 * tooling used) so the "🔧 Ask Claude to fix" inline button still
 * works.
 *
 * Returned Action shape matches event-handlers: `{ stateChanges?,
 * effects?, followUpEvents? }`. If the command is unknown we return a
 * "not found" reply.
 */
async function dispatchHotCommand(cmdName, event, core) {
    const registry = getHotCommands()
    const handler = registry.get(cmdName)
    if (typeof handler !== "function") {
        dbg("HOT-CMD", `unknown command /${cmdName} at v=${globalThis.cbgVersion} (registry size=${registry.size})`)
        return {
            effects: [
                {
                    type: "send_text_to_user",
                    chatId: event.chatId,
                    text: `Unknown command: /${cmdName}. Use /help to see available commands.`,
                    options: event.threadId != null ? { message_thread_id: Number(event.threadId) } : {},
                },
            ],
        }
    }

    let action
    try {
        action = await handler(event, core)
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const stack = err instanceof Error ? (err.stack ?? "") : ""
        dbg("HOT-CMD", `command ${cmdName} threw:`, err)
        const errorId = randomHex(4)
        return {
            stateChanges: {
                chatState: {
                    commandErrors: {
                        [errorId]: {
                            cmdName,
                            error: msg,
                            stack,
                            originalText: event.text ?? "",
                            createdAt: Date.now(),
                        },
                    },
                },
            },
            effects: [
                {
                    type: "send_text_to_user",
                    chatId: event.chatId,
                    text: `⚠️ /${cmdName} failed: ${msg}`,
                    options: {
                        format: "plain",
                        buttons: [[
                            { label: "🔧 Ask Claude to fix", callbackData: `cmderr:fix:${errorId}` },
                        ]],
                        ...(event.threadId != null ? { message_thread_id: Number(event.threadId) } : {}),
                    },
                },
            ],
        }
    }

    return action ?? {}
}

export default async function handle(event, core) {
    const { chatId, userId, messageId, text } = event
    if (!text) {
        return { stateChanges: {}, effects: [] }
    }

    const trimmed = text.trim()
    dbg("CHAT-USER", `msg from ${userId} in ${chatId}: ${trimmed.slice(0, 80)}`)

    // Compute a record patch for `specialData.telegramMessagesByChatId`
    // so every inbound user message lands in the per-chat log. The
    // returned `wrap` helper merges it into whichever Action we build
    // below so each return path records the inbound. The patch is
    // computed once against the current state snapshot — handlers run
    // one at a time so no interleaving concerns.
    const senderId = String(userId ?? "")
    const inboundEntry = {
        id: String(messageId),
        chatId,
        from: "user",
        kind: "regular",
        ts: event.ts,
        text: trimmed.slice(0, 500),
        userId: senderId || null,
        username: event.username ?? null,
        replyToMessageId: event.replyToMessageId != null ? String(event.replyToMessageId) : null,
    }
    const existingChatMessages = core.specialData?.telegramMessagesByChatId?.[chatId] ?? {}
    const inboundPatch = buildRecordPatch(existingChatMessages, inboundEntry)
    function wrap(action) {
        const prev = action?.stateChanges ?? {}
        const prevSpecial = prev.specialData ?? {}
        const prevByChat = prevSpecial.telegramMessagesByChatId ?? {}
        const prevForChat = prevByChat[chatId] ?? {}
        return {
            ...action,
            stateChanges: {
                ...prev,
                specialData: {
                    ...prevSpecial,
                    telegramMessagesByChatId: {
                        ...prevByChat,
                        [chatId]: { ...prevForChat, ...inboundPatch },
                    },
                },
            },
        }
    }

    // 1. Access control. Read the on-disk access.json allowlist each time
    //    so /telegram:access changes take effect without a daemon restart.
    //    We only gate PLAIN TEXT here — slash commands dispatch to the
    //    hot-command registry unconditionally and each command does its
    //    own allowlist check (public ones like /start, /help, /ping,
    //    /status, /version do not gate). This restores legacy pre-gate
    //    behavior without reopening the plain-text exfil hole.
    //
    //    Command center groups bypass the allowlist entirely — being in
    //    the group is the trust boundary.
    const access = loadAccess()
    const isCommandCenter = String(chatId) === String(access.commandCenterChatId ?? "")
    const isAllowed = isCommandCenter || (senderId && access.allowFrom?.includes(senderId))
    const isCommand = trimmed.startsWith("/")
    if (!isAllowed && !isCommand) {
        dbg("CHAT-USER", `DROPPED: user ${senderId} not on allowlist (text=${trimmed.slice(0, 40)})`)
        return { stateChanges: {}, effects: [] }
    }

    // 1.5 Attachment handling. Runs BEFORE the command-regex dispatches
    // so attachments always go to the focused session instead of being
    // parsed as slash commands (their synthesized text starts with "(").
    if (event.attachment) {
        return wrap(handleAttachment(event, core))
    }

    // 2. Dynamic session-switch commands: /switch_<id> or /chat_<id>
    const switchMatch = /^\/(?:switch|chat)_([a-zA-Z0-9_]+)/i.exec(trimmed)
    if (switchMatch) {
        return wrap(handleSwitch(event, core, switchMatch[1]))
    }
    // /close_<id> — graceful session close (types /exit in the TUI,
    // falls back to SIGTERM after a grace period if still alive).
    const closeMatch = /^\/close_([a-zA-Z0-9_]+)/i.exec(trimmed)
    if (closeMatch) {
        return wrap(handleClose(event, core, closeMatch[1]))
    }

    // 3. Task dynamic commands.
    const taskStatusMatch = /^\/task_status_(\w+)/i.exec(trimmed)
    if (taskStatusMatch) {
        return wrap(handleTaskStatus(event, core, taskStatusMatch[1]))
    }
    const taskViewMatch = /^\/task_view_(\w+)/i.exec(trimmed)
    if (taskViewMatch) {
        return wrap(handleTaskView(event, core, taskViewMatch[1]))
    }
    // /task_update_<id> [optional rest of message]
    const taskUpdateMatch = /^\/task_update_(\w+)(?:\s+([\s\S]*))?$/i.exec(trimmed)
    if (taskUpdateMatch) {
        return wrap(handleTaskUpdate(event, core, taskUpdateMatch[1], taskUpdateMatch[2] ?? ""))
    }
    const taskCancelMatch = /^\/task_cancel_(\w+)/i.exec(trimmed)
    if (taskCancelMatch) {
        return wrap(handleTaskCancel(event, core, taskCancelMatch[1]))
    }
    const taskResumeMatch = /^\/task_resume_(\w+)/i.exec(trimmed)
    if (taskResumeMatch) {
        return wrap(handleTaskResume(event, core, taskResumeMatch[1]))
    }
    // /task <free-form description> — creates a new long task. Must come
    // AFTER the /task_* matchers above so they get first dibs.
    const taskNewMatch = /^\/task\s+(.+)/i.exec(trimmed)
    if (taskNewMatch) {
        return wrap(handleTaskCreate(event, core, taskNewMatch[1].trim()))
    }

    // 3b. Scheduled-task dynamic commands. Same ordering rule: specific
    // /schedule_*_<id> matchers first, then the open /schedule <desc>.
    const scheduleStatusMatch = /^\/schedule_status_(\w+)/i.exec(trimmed)
    if (scheduleStatusMatch) {
        return wrap(handleScheduleStatus(event, core, scheduleStatusMatch[1]))
    }
    const scheduleViewMatch = /^\/schedule_view_(\w+)/i.exec(trimmed)
    if (scheduleViewMatch) {
        return wrap(handleScheduleView(event, core, scheduleViewMatch[1]))
    }
    const scheduleCancelMatch = /^\/schedule_cancel_(\w+)/i.exec(trimmed)
    if (scheduleCancelMatch) {
        return wrap(buildScheduleCancelAction(core, event.chatId, scheduleCancelMatch[1]))
    }
    const schedulePauseMatch = /^\/schedule_pause_(\w+)/i.exec(trimmed)
    if (schedulePauseMatch) {
        return wrap(handleSchedulePause(event, core, schedulePauseMatch[1]))
    }
    const scheduleNewMatch = /^\/schedule\s+(.+)/i.exec(trimmed)
    if (scheduleNewMatch) {
        return wrap(handleScheduleCreate(event, core, scheduleNewMatch[1].trim()))
    }

    // 4. Hot-reloadable commands (e.g. /list, /new, /task, /help, ...).
    // Commands live under commands/*.js + $CUSTOM_COMMANDS_DIR and
    // return Actions of their own shape — we merge the result via
    // `wrap()` so the inbound-message record patch is preserved.
    if (trimmed.startsWith("/")) {
        const cmdMatch = /^\/(\w+)/.exec(trimmed)
        if (cmdMatch) {
            const cmdName = cmdMatch[1].toLowerCase()
            // Strip @BotUsername suffix that Telegram appends in groups
            // (e.g. "/peek@MyBot arg" → "/peek arg") so command handlers
            // don't have to deal with it individually.
            const stripped = trimmed.replace(/^\/\w+@\w+/, "/" + cmdName)
            const cmdEvent = { ...event, text: stripped }
            const cmdAction = await dispatchHotCommand(cmdName, cmdEvent, core)
            return wrap(cmdAction)
        }
    }

    // 5. Plain text → deliver to focused (or reply-to-targeted) session.
    //
    // Command center routing: if this message comes from the command
    // center group, route by topic → session mapping instead of focus.
    // General topic (no threadId or threadId not in map) gets no routing.
    //
    // Reply-to routing: if this message is a Telegram reply to a message
    // we've previously recorded in `specialData.telegramMessagesByChatId`,
    // route the reply to whichever session that message is associated
    // with. That entry's `sessionId` field is set by the `reply` tool
    // handler so the user can answer a specific session by replying-to
    // its message even when focus has moved elsewhere.
    //
    // Fallbacks, in order: command center topic → stored entry → legacy
    // `/chat_<id>` header inside replyToText → currently focused session.
    const focusedId = core.chatState?.focusedSessionId
    let targetSessionId = focusedId

    // Command center topic-based routing takes priority
    if (isCommandCenter && event.threadId) {
        const cc = core.chatState?.commandCenter ?? {}
        const threadKey = String(event.threadId)
        const mappedSession = cc.threadMap?.[threadKey]
        if (mappedSession && core.chatSessions?.[mappedSession]) {
            dbg("CHAT-USER", `command center topic routing: thread ${threadKey} → session ${mappedSession}`)
            targetSessionId = mappedSession
        } else if (!mappedSession) {
            // Orphan topic — no session bound
            return wrap({
                stateChanges: {},
                effects: [{
                    type: "send_text_to_user",
                    chatId,
                    text: "No session is attached to this topic. Use /refresh to spawn one.",
                    options: { parse_mode: "HTML", message_thread_id: Number(event.threadId) },
                }],
            })
        } else {
            // Stale mapping — session was registered but has since disconnected
            dbg("CHAT-USER", `stale threadMap entry: thread ${threadKey} → ${mappedSession} (session gone)`)
            return wrap({
                stateChanges: {},
                effects: [{
                    type: "send_text_to_user",
                    chatId,
                    text: `Session <code>${esc(mappedSession)}</code> has disconnected. Use /refresh to respawn it.`,
                    options: { parse_mode: "HTML", message_thread_id: Number(event.threadId) },
                }],
            })
        }
    }
    const replyToMid = event.replyToMessageId != null ? String(event.replyToMessageId) : null
    if (replyToMid) {
        const prior = core.specialData?.telegramMessagesByChatId?.[chatId]?.[replyToMid]
        if (prior?.sessionId && core.chatSessions?.[prior.sessionId]) {
            dbg("CHAT-USER", `reply-to override (state): routing to ${prior.sessionId}`)
            targetSessionId = prior.sessionId
        } else if (event.replyToText) {
            const m = /^\/(?:switch|chat)_([a-zA-Z0-9_-]+)/i.exec(event.replyToText)
            if (m) {
                const candidate = m[1]
                if (core.chatSessions?.[candidate]) {
                    dbg("CHAT-USER", `reply-to override (header fallback): routing to ${candidate}`)
                    targetSessionId = candidate
                } else {
                    dbg("CHAT-USER", `reply-to header pointed at gone session ${candidate}; falling back to focused ${focusedId}`)
                }
            }
        }
    }

    // Queue when no session is available to receive the message. Capped at
    // 50 entries — once full, we drop the oldest and warn the user. The
    // queue is drained by session-register.js when a session next becomes
    // focused.
    if (!targetSessionId) {
        return wrap(enqueueWaitingMessage(event, core, trimmed))
    }

    const session = core.chatSessions?.[targetSessionId]
    if (!session?._conn) {
        return wrap(reply(
            chatId,
            `Session <code>${esc(targetSessionId)}</code> is disconnected — the Claude process is gone. Start a new one with /new.`,
            event.threadId,
        ))
    }

    // Schedule the stall watchdog for this new waiting state. No-op if
    // the session is already `working`.
    const activation = activateWaitingState(session, targetSessionId, event.ts, "askAgentToSendChatMessage")

    // No spinner effect emitted here — the built-in spinner policy in
    // main-event-processor.js picks up the deliver_channel_event below
    // and starts a spinner for targetSessionId. See lib/spinner.js.
    return wrap({
        stateChanges: {
            chatSessions: {
                [targetSessionId]: {
                    lastInbound: {
                        messageId: String(messageId),
                        chatId,
                        ts: event.ts,
                        text: trimmed.slice(0, 500),
                    },
                    ...activation.patch,
                },
            },
        },
        effects: [
            {
                type: "deliver_channel_event",
                sessionId: targetSessionId,
                content: trimmed,
                meta: { message_id: String(messageId), chat_id: chatId },
            },
            ...activation.effects,
            {
                type: "cold_append",
                stream: "messages",
                entry: {
                    from: "user",
                    chatId,
                    userId,
                    messageId,
                    text: trimmed.slice(0, 500),
                    sessionId: targetSessionId,
                },
            },
        ],
    })
}

/**
 * Append a plain-text inbound message to chatState.messageQueue when no
 * session is available to deliver it. Capped at 50 entries — when full,
 * the oldest is dropped and the user is told.
 *
 * Returns a fully-formed Action. The queue array is rebuilt with a spread
 * (NOT mutated) because mergeSessionData replaces arrays wholesale.
 */
const MESSAGE_QUEUE_CAP = 50

function enqueueWaitingMessage(event, core, trimmed) {
    const { chatId, messageId } = event
    const existing = core.chatState?.messageQueue ?? []
    const entry = {
        content: trimmed,
        meta: { message_id: String(messageId), chat_id: chatId },
        queuedAt: event.ts,
    }
    let nextQueue
    let userText = "No focused session; queued. Will deliver when a session registers."
    if (existing.length >= MESSAGE_QUEUE_CAP) {
        dbg("CHAT-USER", `messageQueue full (${existing.length}); dropping oldest`)
        // Drop oldest, append new — immutable rebuild.
        nextQueue = [...existing.slice(1), entry]
        userText = "queue full, dropped oldest entry"
    } else {
        nextQueue = [...existing, entry]
    }
    const queueOptions = { parse_mode: "HTML" }
    if (event.threadId != null) { queueOptions.message_thread_id = Number(event.threadId) }
    return {
        stateChanges: {
            chatState: { messageQueue: nextQueue },
        },
        effects: [
            {
                type: "send_text_to_user",
                chatId,
                text: userText,
                options: queueOptions,
            },
        ],
    }
}

/**
 * Handle a chat_user_message that carries an attachment.
 *
 * All attachments use a two-phase download-first approach:
 *   pass 1: emit a `download_telegram_file` effect whose followUpEvent is
 *     the same event with `_downloaded: true`. The download tooling
 *     re-enqueues the event with imagePath set.
 *   pass 2: event comes back with _downloaded === true → deliver to the
 *     target session with the file path in the message text so Claude
 *     can read the file directly.
 *
 * Command center routing: uses topic→session mapping when in a CC topic,
 * falls back to focusedSessionId otherwise.
 */
function handleAttachment(event, core) {
    const { chatId, userId, messageId, text, attachment } = event
    const caption = (text ?? "").trim()

    // ── Resolve target session (CC topic routing) ────────────────────
    const access = loadAccess()
    const isCC = String(chatId) === String(access.commandCenterChatId ?? "")
    let targetId = null
    if (isCC && event.threadId) {
        const cc = core.chatState?.commandCenter ?? {}
        targetId = cc.threadMap?.[String(event.threadId)] ?? null
        if (targetId) {
            dbg("CHAT-USER", `attachment CC topic ${event.threadId} → session ${targetId}`)
        }
    }
    if (!targetId) {
        targetId = core.chatState?.focusedSessionId
    }
    if (!targetId) {
        return reply(
            chatId,
            "No focused session. Use /list to see available sessions or /new to create one.",
            event.threadId,
        )
    }
    const session = core.chatSessions?.[targetId]
    if (!session?._conn) {
        return reply(
            chatId,
            `Session <code>${esc(targetId)}</code> is disconnected — the Claude process is gone. Start a new one with /new.`,
            event.threadId,
        )
    }

    // ── Pass 1: download the file first ──────────────────────────────
    if (!event._downloaded) {
        const followUpEvent = {
            ...event,
            _downloaded: true,
        }
        return {
            stateChanges: {},
            effects: [
                {
                    type: "download_telegram_file",
                    fileId: attachment.fileId,
                    fileUniqueId: attachment.fileUniqueId,
                    followUpEvent,
                },
            ],
        }
    }

    // ── Pass 2: deliver with file path as plain text ─────────────────
    const filePath = event.imagePath
    const fileName = attachment.name || `${attachment.kind}`
    let content
    if (filePath) {
        const parts = [`[Attached file: ${fileName}]`, `File path: ${filePath}`]
        if (caption) { parts.push(caption) }
        content = parts.join("\n")
    } else {
        content = caption || `(${attachment.kind}: download failed)`
    }

    const meta = {
        message_id: String(messageId),
        chat_id: chatId,
    }
    if (filePath) {
        meta.image_path = filePath
    }
    return deliverAttachment(event, core, targetId, content, meta)
}

function deliverAttachment(event, core, focusedId, content, meta) {
    const { chatId, userId, messageId } = event
    const session = core.chatSessions?.[focusedId]
    const activation = activateWaitingState(session, focusedId, event.ts, "askAgentToSendChatMessage")
    return {
        stateChanges: {
            chatSessions: {
                [focusedId]: {
                    lastInbound: {
                        messageId: String(messageId),
                        chatId,
                        ts: event.ts,
                        text: content.slice(0, 500),
                    },
                    ...activation.patch,
                },
            },
        },
        effects: [
            {
                type: "deliver_channel_event",
                sessionId: focusedId,
                content,
                meta,
            },
            ...activation.effects,
            {
                type: "cold_append",
                stream: "messages",
                entry: {
                    from: "user",
                    chatId,
                    userId,
                    messageId,
                    text: content.slice(0, 500),
                    sessionId: focusedId,
                    attachment: event.attachment?.kind ?? null,
                },
            },
        ],
    }
}

// Grace period before the force-close timer fires. Gives Claude time to
// observe the `/exit` slash command and tear its TUI down cleanly.
const CLOSE_GRACE_MS = 15000

function handleClose(event, core, targetId) {
    const { chatId } = event
    const target = core.chatSessions?.[targetId]
    if (!target) {
        return reply(chatId, `Session <code>${esc(targetId)}</code> not found.`, event.threadId)
    }
    const title = target.title ? ` (${esc(target.title)})` : ""
    const closeOpts = { parse_mode: "HTML" }
    if (event.threadId != null) { closeOpts.message_thread_id = Number(event.threadId) }
    return {
        stateChanges: {},
        effects: [
            // Graceful path: type /exit in the Claude TUI. If the session
            // is idle at the prompt it exits cleanly; if it's mid-turn the
            // text gets queued and the force-close timer below will take
            // over.
            { type: "send_text_to_claude", sessionId: targetId, text: "/exit" },
            {
                type: "send_text_to_user",
                chatId,
                text: `Closing session <code>${esc(targetId)}</code>${title}… sent <code>/exit</code>, will SIGTERM in ${Math.round(CLOSE_GRACE_MS / 1000)}s if still alive.`,
                options: closeOpts,
            },
            // Force-close fallback. The session_force_close handler
            // no-ops if the session has already unregistered.
            {
                type: "set_timer",
                delayMs: CLOSE_GRACE_MS,
                event: {
                    type: "session_force_close",
                    sessionId: targetId,
                    requestChatId: chatId,
                },
            },
        ],
    }
}

function handleSwitch(event, core, targetId) {
    const { chatId } = event
    if (!core.chatSessions?.[targetId]) {
        return reply(chatId, `Session <code>${esc(targetId)}</code> not found.`, event.threadId)
    }
    const target = core.chatSessions[targetId]
    const parts = [`Switched to session <code>${esc(targetId)}</code>`]
    if (target.title) {
        parts.push(esc(target.title))
    }
    return {
        stateChanges: {
            chatState: { focusedSessionId: targetId },
        },
        effects: [
            {
                type: "send_text_to_user",
                chatId,
                text: parts.join(" — "),
                options: { parse_mode: "HTML", ...(event.threadId != null ? { message_thread_id: Number(event.threadId) } : {}) },
            },
        ],
    }
}

function reply(chatId, text, threadId) {
    const options = { parse_mode: "HTML" }
    if (threadId != null) { options.message_thread_id = Number(threadId) }
    return {
        stateChanges: {},
        effects: [
            {
                type: "send_text_to_user",
                chatId,
                text,
                options,
            },
        ],
    }
}

// ── Waiting-state activation ────────────────────────────────────────
//
// ⚠️  This helper is the main write-site for session-level nudge state
//    (status, agentRequest, pendingNudgeAction, agentRequestStartedAt).
//    The full state machine — fields, states, transitions, invariants
//    — is documented in docs/session-state.md. Changes here need to
//    stay in sync with claude-hook-stop.js, critic-verdict.js, and
//    the daemon reload path.
//
// When a user message arrives and the receiving session is NOT already
// working on a prior request, bump `agentRequest`, flip status to
// "working", and schedule a stall_check timer. The timer carries the
// new `agentRequest` value so later stale stall_checks (from earlier
// requests) can recognize themselves and exit.
//
// If the session IS already `working`, we don't start a new request
// epoch (per the `agentRequest` rule: mid-turn inbounds don't bump
// the counter). BUT we still care about nudge tracking — consider:
//
//   1. User sends msg 1 → session goes idle → working, pendingNudgeAction
//      = askAgentToSendChatMessage.
//   2. Agent replies to msg 1 → handleReply clears pendingNudgeAction
//      to "none". Status stays "working" (only Stop → idle).
//   3. User sends msg 2 → session still "working". If we did nothing,
//      pendingNudgeAction stays "none" and the next Stop wouldn't
//      nudge even though msg 2 is unanswered.
//
// So when the session is working AND pendingNudgeAction is "none"
// (the agent answered everything prior), we REFRESH the action
// without bumping agentRequest. The in-flight stall_check keeps its
// original forAgentRequest — we don't schedule a new one — and the
// next Stop picks up the refreshed pending action. If the agent
// replies again before Stop, handleReply re-clears and the cycle
// repeats harmlessly.
//
// The caller passes `preferredNudgeAction` — the nudge-on-Stop action
// that should fire if the agent ends its turn without responding. For
// plain-text messages this is "askAgentToSendChatMessage". For /task,
// it's "taskCheck" (the task check overrides a plain reply nudge).
// When a session already has an active long task, any new request
// promotes its action to "taskCheck" regardless of caller preference
// — the long task is the primary commitment.

function activateWaitingState(session, sessionId, ts, preferredNudgeAction) {
    const hasLongTask = typeof session?.longTaskId === "string" && session.longTaskId.length > 0
    const resolvedNudgeAction = hasLongTask ? "taskCheck" : preferredNudgeAction

    if (session?.status === "working") {
        // Mid-turn inbound. Don't bump agentRequest. Only refresh the
        // nudge action if the prior one was already cleared — otherwise
        // we'd clobber a still-pending taskCheck or an already-set
        // reply-nudge that hasn't fired yet.
        if (session.pendingNudgeAction === "none" || session.pendingNudgeAction == null) {
            return { patch: { pendingNudgeAction: resolvedNudgeAction }, effects: [] }
        }
        return { patch: {}, effects: [] }
    }

    const nextAgentRequest = (session?.agentRequest ?? 0) + 1
    const patch = {
        status: "working",
        agentRequest: nextAgentRequest,
        agentRequestStartedAt: ts,
        pendingNudgeAction: resolvedNudgeAction,
    }
    const effects = [
        {
            type: "set_timer",
            delayMs: STALL_CHECK_BOOTSTRAP_MS,
            event: {
                type: "stall_check",
                sessionId,
                forAgentRequest: nextAgentRequest,
            },
        },
    ]
    return { patch, effects }
}

// Bootstrap delay for the FIRST stall_check of a new waiting state.
// Fixed rather than config-fetched: the handler itself fresh-reads the
// runtime interval on reschedule, so this just determines the initial
// lag before the first check runs. Match the default configured check
// interval so behavior is predictable.
const STALL_CHECK_BOOTSTRAP_MS = 30_000

// ── Long task handlers ──────────────────────────────────────────────

/**
 * Look up a task by id within a specific chat. Returns the task object
 * or null if not found. Tasks are stored at
 * core.specialData.longTaskByChatId[chatId][taskId].
 */
function findTask(core, chatId, taskId) {
    return core?.specialData?.longTaskByChatId?.[chatId]?.[taskId] ?? null
}

/** Format an age string from an ISO timestamp like "12m" / "3h" / "2d". */
function formatAge(when) {
    if (when == null) {
        return "unknown"
    }
    // Accept both ISO strings (task.createdAt) and numeric ts
    // (lastNudgeAt / criticLastCallAt, written as event.ts). Date's
    // constructor handles both shapes; Date.parse only takes strings.
    const then = typeof when === "number" ? when : Date.parse(when)
    if (Number.isNaN(then)) {
        return "unknown"
    }
    const ageMs = Date.now() - then
    const m = Math.floor(ageMs / 60000)
    if (m < 1) {
        return "just now"
    }
    if (m < 60) {
        return `${m}m ago`
    }
    const h = Math.floor(m / 60)
    if (h < 24) {
        return `${h}h ago`
    }
    const d = Math.floor(h / 24)
    return `${d}d ago`
}

// `taskCommandLinks` moved to lib/long-task-actions.js and imported at
// the top of the file so it can be shared with other long-task code
// (notably long-task-definition-submitted.js, which now owns the
// "Task started" user-facing message).

/**
 * /task <description> — start a new long task.
 *
 * Generates an id, drops a task object into specialData with state
 * "defining", and tells the focused worker session to draft a definition
 * of done via the submit_long_task_definition MCP tool.
 */
function handleTaskCreate(event, core, description) {
    const { chatId } = event
    if (!description) {
        return reply(chatId, "Usage: <code>/task &lt;description&gt;</code>", event.threadId)
    }

    const focusedId = core.chatState?.focusedSessionId
    if (!focusedId) {
        return reply(chatId, "No focused session. Use /new to create one first.", event.threadId)
    }

    // One-task-per-session invariant. The terminal branches
    // (handleTaskCancel, critic-verdict certified/escalated) are
    // responsible for clearing session.longTaskId on their way out —
    // so a live longTaskId here means an actual in-flight task we
    // must not clobber.
    //
    // Dangling-pointer defense: if longTaskId is set but the task
    // entry is MISSING from specialData (bug, persistence race,
    // manual edit), we treat the pointer as stale and fall through.
    // The new task's state patch will overwrite the pointer, which
    // is the correct recovery.
    const focusedSession = core.chatSessions?.[focusedId]
    const existingTaskId = focusedSession?.longTaskId
    if (existingTaskId) {
        const existing = core.specialData?.longTaskByChatId?.[chatId]?.[existingTaskId]
        if (existing) {
            dbg(
                "CHAT-USER",
                `refusing /task: session ${focusedId} already owns ${existingTaskId} (state=${existing.state})`,
            )
            const lines = [
                `Session <code>${esc(focusedId)}</code> already has an active task ` +
                `<code>${esc(existingTaskId)}</code> (state: <code>${esc(existing.state ?? "?")}</code>).`,
                ``,
                `Edit or cancel it first:`,
                ``,
                taskCommandLinks(existingTaskId),
            ]
            return reply(chatId, lines.join("\n"), event.threadId)
        }
        dbg(
            "CHAT-USER",
            `stale longTaskId=${existingTaskId} on session ${focusedId}; overwriting with new task`,
        )
    }

    const taskId = generateUniqueTaskId(core)
    const title = description.split(/\s+/).slice(0, 6).join(" ")
    const createdAt = new Date().toISOString()

    const newTask = {
        id: taskId,
        title,
        originalPrompt: description,
        createdAt,
        state: "defining",
        workerSessionId: focusedId,
        definition: null,
        // Nudge-watchdog counters — incremented by claude-hook-stop.js
        // when the task-check branch fires a "write report.md if done"
        // nudge or decides the worker is still churning.
        consecutiveIdleStops: 0,
        totalNudges: 0,
        lastNudgeAt: null,
        // Critic subprocess observability — incremented by
        // claude-hook-stop.js every time a critic run is spawned.
        // (Retry-attempt state lives on the critic_verdict event chain,
        // not on the task — see critic-verdict.js:handleRetry.)
        criticCallCount: 0,
        criticLastCallAt: null,
    }

    // Resolve the on-disk task directory once so the prompt points the
    // worker at the EXACT location the critic subprocess will later read
    // from (paths.longTaskDir(taskId)). Interpolating the literal
    // $HOME/.cbg/long-tasks/... string here silently broke the long-task
    // feature because the real layout is $CBG_DIR/long-tasks/... where
    // CBG_DIR defaults to $HOME/.local/share/cbg.
    const taskDirAbs = paths.longTaskDir(taskId)

    const prompt = [
        `The user would like to start a long task (id: ${taskId}).`,
        ``,
        `User's request:`,
        `> ${description}`,
        ``,
        `First, write a context.md file to ${taskDirAbs}/context.md`,
        `describing the current state: PWD, relevant files, branch, anything a reviewer`,
        `without context would need.`,
        ``,
        `Then, confirm a sufficient definition of done can be created from the user's`,
        `request. Ask clarifying questions via the Telegram reply tool but don't`,
        `bike-shed — the definition should be concrete and falsifiable but doesn't`,
        `need to be exhaustive.`,
        ``,
        `DO NOT include "delivered via Telegram" or any variant as a criterion in`,
        `the definition of done. CBG tracks message delivery out-of-band — it is`,
        `not the worker's or critic's job to prove Telegram delivery happened. If`,
        `the user's request involves producing a deliverable (poem, report,`,
        `summary, etc.) you'll send it via the reply tool as part of your work,`,
        `but the criterion in the DOD should be "the deliverable exists and meets`,
        `X, Y, Z", not "the deliverable was sent to Telegram".`,
        ``,
        `When no clarifications are needed, submit the definition via the`,
        "`submit_long_task_definition` MCP tool with arguments:",
        `  { "taskId": "${taskId}", "definition": "<your markdown definition>" }`,
        ``,
        `After the server locks the definition, begin work:`,
        `- Write progress notes to ${taskDirAbs}/progress.md`,
        `- When done, write ${taskDirAbs}/report.md`,
        `  (a critic will review it independently — include PWD, branch, files`,
        `  changed, and concrete evidence)`,
        ``,
        `<user_prompt>`,
        description,
        `</user_prompt>`,
    ].join("\n")

    dbg("CHAT-USER", `creating long task ${taskId} for session ${focusedId}`)

    // Activate the waiting state for this new long task. The session now
    // "owns" the task via longTaskId, and the Stop handler's taskCheck
    // branch will watch for report.md / nudge as turns come and go.
    // Overwrite activation's pendingNudgeAction to "taskCheck" — even
    // if the activation's default was askAgentToSendChatMessage, the
    // task takes priority.
    const session = core.chatSessions?.[focusedId]
    const activation = activateWaitingState(session, focusedId, event.ts, "taskCheck")
    const sessionPatch = {
        longTaskId: taskId,
        ...activation.patch,
        // activateWaitingState may have skipped the fields (session was
        // already working) — force pendingNudgeAction to taskCheck so
        // the Stop handler sees the task even if the session was mid-turn.
        pendingNudgeAction: "taskCheck",
    }

    return {
        stateChanges: {
            specialData: {
                longTaskByChatId: {
                    [chatId]: {
                        [taskId]: newTask,
                    },
                },
            },
            chatSessions: {
                [focusedId]: sessionPatch,
            },
        },
        effects: [
            // Pre-create the task directory so the worker can write
            // context.md / progress.md / report.md immediately, without
            // the first Write tool call having to mkdir its own parent.
            // Effects run in order, and this one fires before the
            // deliver_channel_event that tells the worker about the
            // task, so the directory is always in place when the
            // worker's first Write lands.
            {
                type: "mkdir",
                path: taskDirAbs,
            },
            {
                type: "deliver_channel_event",
                sessionId: focusedId,
                content: prompt,
                meta: {},
            },
            ...activation.effects,
            {
                type: "send_text_to_user",
                chatId,
                text: `/task_cancel_${taskId}`,
                options: { parse_mode: "HTML", ...(event.threadId != null ? { message_thread_id: Number(event.threadId) } : {}) },
            },
            {
                type: "cold_append",
                stream: "long-tasks",
                entry: {
                    event: "created",
                    taskId,
                    chatId,
                    sessionId: focusedId,
                    title,
                },
            },
        ],
    }
}

function handleTaskStatus(event, core, taskId) {
    const { chatId } = event
    const task = findTask(core, chatId, taskId)
    if (!task) {
        return reply(chatId, `Task <code>${esc(taskId)}</code> not found.`, event.threadId)
    }

    const definitionStatus = task.definition ? "set" : "not yet submitted"

    // formatAge() takes an ISO string OR a numeric ts. lastNudgeAt and
    // criticLastCallAt are written as numeric ts by claude-hook-stop.js;
    // formatAge handles both via its Date(...) constructor call.
    const critStr = task.criticCallCount
        ? `${task.criticCallCount} (last ${formatAge(task.criticLastCallAt)})`
        : "none"
    const nudgeStr = task.totalNudges
        ? `${task.totalNudges} (last ${formatAge(task.lastNudgeAt)})`
        : "none"

    const lines = [
        `<b>Task</b> <code>${esc(taskId)}</code>`,
        `<b>Title:</b> ${esc(task.title ?? "(untitled)")}`,
        `<b>State:</b> <code>${esc(task.state ?? "unknown")}</code>`,
        `<b>Worker:</b> <code>${esc(task.workerSessionId ?? "?")}</code>`,
        `<b>Created:</b> ${esc(formatAge(task.createdAt))}`,
        `<b>Definition:</b> ${esc(definitionStatus)}`,
        `<b>Critic calls:</b> ${esc(critStr)}`,
        `<b>Nudges:</b> ${esc(nudgeStr)}`,
        ``,
        taskCommandLinks(taskId),
    ]
    return reply(chatId, lines.join("\n"), event.threadId)
}

function handleTaskView(event, core, taskId) {
    const { chatId } = event
    const task = findTask(core, chatId, taskId)
    if (!task) {
        return reply(chatId, `Task <code>${esc(taskId)}</code> not found.`, event.threadId)
    }
    if (!task.definition) {
        return reply(
            chatId,
            `Task <code>${esc(taskId)}</code> has no definition yet (still in <code>defining</code> state).`,
            event.threadId,
        )
    }
    // Truncate to 3000 chars; the outbound chunker handles longer messages
    // automatically but the explicit cap keeps a single /task_view from
    // dumping a runaway definition into chat.
    const def = task.definition.slice(0, 3000)
    const truncated = task.definition.length > def.length ? "\n\n[truncated]" : ""
    const text = `<b>Definition of done — </b><code>${esc(taskId)}</code>\n<pre>${esc(def)}${esc(truncated)}</pre>`
    return reply(chatId, text, event.threadId)
}

function handleTaskUpdate(event, core, taskId, body) {
    const { chatId } = event
    const task = findTask(core, chatId, taskId)
    if (!task) {
        return reply(chatId, `Task <code>${esc(taskId)}</code> not found.`, event.threadId)
    }

    const newDefinition = (body ?? "").trim()
    if (!newDefinition) {
        // No body — show the current definition + the usage hint.
        if (!task.definition) {
            return reply(
                chatId,
                `Task <code>${esc(taskId)}</code> has no definition yet. Reply with <code>/task_update_${esc(taskId)} &lt;new text&gt;</code> to set one.`,
                event.threadId,
            )
        }
        const def = task.definition.slice(0, 3000)
        const truncated = task.definition.length > def.length ? "\n\n[truncated]" : ""
        const text =
            `<b>Current definition — </b><code>${esc(taskId)}</code>\n` +
            `<pre>${esc(def)}${esc(truncated)}</pre>\n` +
            `Reply with <code>/task_update_${esc(taskId)} &lt;new text&gt;</code> to replace.`
        return reply(chatId, text, event.threadId)
    }

    dbg("CHAT-USER", `updating definition for task ${taskId} (${newDefinition.length} chars)`)

    const workerSessionId = task.workerSessionId

    // If the task is stuck in `awaiting_clarification` (the critic said
    // the definition was unclear), a user-supplied update is the signal
    // to resume work. Flip it back to `in_progress` and reset the nudge
    // counter so the worker isn't immediately yelled at on its next Stop.
    // Any other state is left alone — editing a definition mid-flight
    // shouldn't change its lifecycle state.
    const stateUpdate = task.state === "awaiting_clarification"
        ? { state: "in_progress", consecutiveIdleStops: 0, pendingNudgeAction: "none" }
        : {}

    const resumedFromClarification = task.state === "awaiting_clarification"
    const replyText = resumedFromClarification
        ? `Definition updated for <code>${esc(taskId)}</code>. Resumed.`
        : `Definition updated for <code>${esc(taskId)}</code>.`

    const effects = [
        {
            type: "send_text_to_user",
            chatId,
            text: replyText,
            options: { parse_mode: "HTML", ...(event.threadId != null ? { message_thread_id: Number(event.threadId) } : {}) },
        },
        {
            type: "cold_append",
            stream: "long-tasks",
            entry: {
                event: "definition_updated",
                taskId,
                chatId,
                sessionId: workerSessionId,
                definitionLength: newDefinition.length,
                resumedFromClarification,
            },
        },
        // Rewrite the on-disk backup so restart recovery picks up the new
        // definition rather than the old one.
        {
            type: "write_file",
            path: paths.longTaskDefinitionBackupFile(taskId),
            content: newDefinition,
        },
    ]

    if (workerSessionId) {
        effects.push({
            type: "deliver_channel_event",
            sessionId: workerSessionId,
            content:
                `[long task ${taskId} — definition updated]\n` +
                `The user has updated the definition of done. Review your progress and adjust.\n\n` +
                `New definition:\n${newDefinition}`,
            meta: {},
        })
    }

    return {
        stateChanges: {
            specialData: {
                longTaskByChatId: {
                    [chatId]: {
                        [taskId]: { definition: newDefinition, ...stateUpdate },
                    },
                },
            },
        },
        effects,
    }
}

function handleTaskCancel(event, core, taskId) {
    const { chatId } = event
    const result = buildCancelAction(core, chatId, taskId)
    if (!result.ok) {
        return reply(chatId, result.reason, event.threadId)
    }
    return result.action
}

/**
 * /task_resume_<id> — revive a previously-cancelled task.
 *
 * Looks up the task, rejects if it isn't cancelled. Finds the worker
 * session via task.workerSessionId. Rejects if that session already
 * owns another active task (one-task-per-session invariant holds on
 * resume just like on create). Reactivates the waiting state with
 * pendingNudgeAction: "taskCheck" and notifies the worker via channel
 * event.
 */
function handleTaskResume(event, core, taskId) {
    const { chatId } = event
    const task = findTask(core, chatId, taskId)
    if (!task) {
        return reply(chatId, `Task <code>${esc(taskId)}</code> not found.`, event.threadId)
    }
    if (task.state !== "cancelled") {
        return reply(
            chatId,
            `Task <code>${esc(taskId)}</code> is not cancelled (current state: ` +
            `<code>${esc(task.state ?? "?")}</code>). Nothing to resume.`,
            event.threadId,
        )
    }

    const workerSessionId = task.workerSessionId
    if (!workerSessionId) {
        return reply(
            chatId,
            `Task <code>${esc(taskId)}</code> has no worker session recorded. Cannot resume.`,
            event.threadId,
        )
    }
    const workerSession = core.chatSessions?.[workerSessionId]
    if (!workerSession) {
        return reply(
            chatId,
            `Worker session <code>${esc(workerSessionId)}</code> for this task is gone. Cannot resume.`,
            event.threadId,
        )
    }
    if (workerSession.longTaskId && workerSession.longTaskId !== taskId) {
        const existing = workerSession.longTaskId
        return reply(
            chatId,
            `Worker session <code>${esc(workerSessionId)}</code> is already running ` +
            `task <code>${esc(existing)}</code>. Cancel that one first.`,
            event.threadId,
        )
    }

    // Restore the pre-cancel state. If the worker had already submitted
    // a definition before the cancel, it goes back to "in_progress";
    // otherwise back to "defining".
    const restoredState = task.stateBeforeCancel
        ?? (task.definition ? "in_progress" : "defining")

    dbg("CHAT-USER", `resuming long task ${taskId} → state=${restoredState}`)

    const activation = activateWaitingState(workerSession, workerSessionId, event.ts, "taskCheck")
    const sessionPatch = {
        longTaskId: taskId,
        ...activation.patch,
    }

    return {
        stateChanges: {
            specialData: {
                longTaskByChatId: {
                    [chatId]: {
                        [taskId]: {
                            state: restoredState,
                            // Clear the cancel markers so the task looks
                            // pristine again.
                            stateBeforeCancel: undefined,
                            cancelledAt: undefined,
                            resumedAt: new Date().toISOString(),
                        },
                    },
                },
            },
            chatSessions: {
                [workerSessionId]: sessionPatch,
            },
        },
        effects: [
            {
                type: "send_text_to_user",
                chatId,
                text: `Task <code>${esc(taskId)}</code> resumed.`,
                options: { parse_mode: "HTML", ...(event.threadId != null ? { message_thread_id: Number(event.threadId) } : {}) },
            },
            {
                type: "cold_append",
                stream: "long-tasks",
                entry: {
                    event: "resumed",
                    taskId,
                    chatId,
                    sessionId: workerSessionId,
                },
            },
            {
                type: "deliver_channel_event",
                sessionId: workerSessionId,
                content:
                    `[long task ${taskId} — resumed]\n` +
                    `The user has resumed this task. Continue working on it.`,
                meta: {},
            },
            ...activation.effects,
        ],
    }
}

// buildHotCommandState (the legacy `(ctx, bot, state)` bridge) was
// removed after commands/*.js were ported to the Action-returning
// contract. See dispatchHotCommand() at the top of this file.

// ── /schedule feature handlers ────────────────────────────────────────

function generateUniqueScheduleId(core) {
    const existing = new Set()
    const byChat = core.specialData?.scheduledTaskByChatId ?? {}
    for (const tasks of Object.values(byChat)) {
        for (const id of Object.keys(tasks ?? {})) { existing.add(id) }
    }
    let id
    do { id = `sch_${randomHex(3)}` } while (existing.has(id))
    return id
}

function handleScheduleCreate(event, core, description) {
    const { chatId } = event
    if (!description) {
        return reply(chatId, "Usage: <code>/schedule &lt;description&gt;</code>", event.threadId)
    }
    const focusedId = core.chatState?.focusedSessionId
    if (!focusedId) {
        return reply(chatId, "No focused session. Use /new to create one first.", event.threadId)
    }

    const scheduleTaskId = generateUniqueScheduleId(core)
    const title = description.split(/\s+/).slice(0, 6).join(" ")
    const createdAt = new Date().toISOString()
    const newTask = {
        id: scheduleTaskId,
        title,
        originalPrompt: description,
        createdAt,
        state: "defining",
        draftingSessionId: focusedId,
        definitionOfDone: null,
        rule: null,
        tracking: {
            totalRuns: 0,
            lastRunAt: null,
            lastRunStatus: null,
            lastRunSummary: null,
            nextFireAt: null,
            skipNext: false,
            runHistory: [],
        },
        currentRun: null,
    }
    const taskDirAbs = paths.scheduledTaskDir(scheduleTaskId)

    const prompt = [
        `The user would like to schedule a RECURRING task (id: ${scheduleTaskId}).`,
        ``,
        `User's request:`,
        `> ${description}`,
        ``,
        `YOUR JOB in this phase:`,
        ``,
        `1. Clarify the RECURRENCE RULE with the user. Produce an rrule.js`,
        `   JSON object with these fields:`,
        `     freq (required): YEARLY | MONTHLY | WEEKLY | DAILY | HOURLY | MINUTELY`,
        `     interval?, byhour?, byminute?, byday? (array of "MO","TU","WE","TH","FR","SA","SU"),`,
        `     bymonth?, bymonthday?, count?, until?, tzid? (IANA string)`,
        ``,
        `   Timezone handling rules — MUST follow these before submitting:`,
        `   - If config schedule_default_tz is set, silently use it and mention`,
        `     the choice in your confirmation.`,
        `   - If the rule has NO meaningful time-of-day (e.g. a monthly or`,
        `     yearly rule with no explicit hour), silently default tzid to`,
        `     the daemon's system timezone`,
        `     (Intl.DateTimeFormat().resolvedOptions().timeZone) and say so.`,
        `   - If the user's wording carries context ("in the morning", "before`,
        `     my meeting at 2pm", "after work"), infer a concrete time + tz and`,
        `     ECHO the inference explicitly in your confirmation.`,
        `   - Otherwise ASK EXPLICITLY: "Should this fire at <time> in your`,
        `     current timezone (<sys tz>) or fixed in a specific timezone?"`,
        `   - Sunrise / sunset and "follow me while traveling" are NOT supported`,
        `     in v1 — push back if the user asks for either.`,
        ``,
        `2. Write a DEFINITION OF DONE that is concrete and falsifiable. The`,
        `   DoD MUST name the exact file path the worker should write its`,
        `   output to each run. The worker's cwd will be the task directory:`,
        `     ${taskDirAbs}`,
        `   A typical output path is \`runs/<runIso>/report.md\` under that cwd.`,
        ``,
        `3. Call the MCP tool \`submit_scheduled_task_definition\` with:`,
        `     { "scheduleTaskId": "${scheduleTaskId}",`,
        `       "rule": { ... rrule JSON ... },`,
        `       "definitionOfDone": "... markdown ...",`,
        `       "title": "... optional short name ..." }`,
        ``,
        `DO NOT include "delivered via Telegram" as a DoD criterion — the CBG`,
        `daemon sends the final telegram message itself when the critic`,
        `certifies each run.`,
        ``,
        `<user_prompt>`,
        description,
        `</user_prompt>`,
    ].join("\n")

    dbg("CHAT-USER", `creating scheduled task ${scheduleTaskId} for session ${focusedId}`)

    return {
        stateChanges: {
            specialData: {
                scheduledTaskByChatId: {
                    [chatId]: { [scheduleTaskId]: newTask },
                },
            },
        },
        effects: [
            { type: "mkdir", path: taskDirAbs },
            {
                type: "deliver_channel_event",
                sessionId: focusedId,
                content: prompt,
                meta: {},
            },
            {
                type: "send_text_to_user",
                chatId,
                text: `Drafting scheduled task <code>${esc(scheduleTaskId)}</code> — clarify with the agent, then it'll be locked.`,
                options: { parse_mode: "HTML", ...(event.threadId != null ? { message_thread_id: Number(event.threadId) } : {}) },
            },
        ],
    }
}

function handleScheduleStatus(event, core, scheduleTaskId) {
    const found = findScheduledTask(core.specialData, scheduleTaskId)
    if (!found) {
        return reply(event.chatId, `Unknown scheduled task: <code>${esc(scheduleTaskId)}</code>`, event.threadId)
    }
    const t = found.task
    const totalRuns = t.tracking?.totalRuns ?? 0
    const maxRuns = t.rule?.count
    const runsDisplay = maxRuns != null
        ? `${totalRuns} / ${maxRuns}`
        : String(totalRuns)
    const lines = [
        `<b>Scheduled task <code>${esc(scheduleTaskId)}</code></b>`,
        `State: <code>${esc(t.state ?? "?")}</code>`,
        `Next fire: <code>${esc(t.tracking?.nextFireAt ?? "(none)")}</code>`,
        `Last run: <code>${esc(t.tracking?.lastRunAt ?? "(never)")}</code> — ${esc(t.tracking?.lastRunStatus ?? "(none)")}`,
        `Runs: <code>${esc(runsDisplay)}</code>${maxRuns != null ? (maxRuns === 1 ? " (once)" : ` (${maxRuns}x)`) : " (recurring)"}`,
        `Skip next: <code>${esc(String(t.tracking?.skipNext ?? false))}</code>`,
        ``,
        scheduleCommandLinks(scheduleTaskId),
    ]
    return reply(event.chatId, lines.join("\n"), event.threadId)
}

function handleScheduleView(event, core, scheduleTaskId) {
    const found = findScheduledTask(core.specialData, scheduleTaskId)
    if (!found) {
        return reply(event.chatId, `Unknown scheduled task: <code>${esc(scheduleTaskId)}</code>`, event.threadId)
    }
    const t = found.task
    const history = (t.tracking?.runHistory ?? []).slice(-5).map((r) =>
        `- ${esc(r.at ?? "?")}: <code>${esc(r.status ?? "?")}</code> ${esc((r.summary ?? "").slice(0, 100))}`,
    )
    const lines = [
        `<b>Scheduled task <code>${esc(scheduleTaskId)}</code></b>`,
        `Title: ${esc(t.title ?? "")}`,
        ``,
        `<b>Rule</b>`,
        `<pre>${esc(JSON.stringify(t.rule ?? {}, null, 2))}</pre>`,
        ``,
        `<b>Definition of done</b>`,
        `<pre>${esc((t.definitionOfDone ?? "(none)").slice(0, 2000))}</pre>`,
        ``,
        `<b>Recent runs</b>`,
        ...(history.length > 0 ? history : ["(none)"]),
        ``,
        scheduleCommandLinks(scheduleTaskId),
    ]
    return reply(event.chatId, lines.join("\n"), event.threadId)
}

function handleSchedulePause(event, core, scheduleTaskId) {
    const found = findScheduledTask(core.specialData, scheduleTaskId)
    if (!found) {
        return reply(event.chatId, `Unknown scheduled task: <code>${esc(scheduleTaskId)}</code>`, event.threadId)
    }
    const prev = found.task.tracking?.skipNext ?? false
    const next = !prev
    return {
        stateChanges: {
            specialData: {
                scheduledTaskByChatId: {
                    [found.chatId]: {
                        [scheduleTaskId]: {
                            tracking: { skipNext: next },
                        },
                    },
                },
            },
        },
        effects: [
            {
                type: "send_text_to_user",
                chatId: event.chatId,
                text: `Scheduled task <code>${esc(scheduleTaskId)}</code>: skipNext=${next ? "<b>true</b>" : "false"}`,
                options: { parse_mode: "HTML", ...(event.threadId != null ? { message_thread_id: Number(event.threadId) } : {}) },
            },
        ],
    }
}
