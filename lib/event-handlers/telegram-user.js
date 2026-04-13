// ---------------------------------------------------------------------------
// Handler for `telegram_user_message` events.
//
// MVP dispatcher for Telegram inbound text. Handles:
//   1. Access control (skipped if allowlist is undefined — v1).
//   2. Dynamic regex commands (/switch_<id>, /chat_<id>, /task_*_<id>).
//   3. Hot-reloadable commands — STUBBED, lib/commands.js port pending.
//   4. Plain text → deliver to focused session via channel_event.
//
// Returns an Action; the event-loop dispatcher applies it.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { escapeHtml: esc } = await versionedImport("../pure/html.js", import.meta)
const { generateTaskId } = await versionedImport("../pure/ids.js", import.meta)
const { getRandomTip } = await versionedImport("../hot-commands.js", import.meta)
const { loadAccess } = await versionedImport("../access.js", import.meta)
const { buildRecordPatch } = await versionedImport("../effects/telegram-state.js", import.meta)
const { paths } = await versionedImport("../paths.js", import.meta)

export default function handle(event, core) {
    const { chatId, userId, messageId, text } = event
    if (!text) {
        return { stateChanges: {}, effects: [] }
    }

    const trimmed = text.trim()
    dbg("TG-USER", `msg from ${userId} in ${chatId}: ${trimmed.slice(0, 80)}`)

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
    //    Messages from non-allowlisted users are dropped silently — the
    //    exception is /approve_user, which is the only path by which a new
    //    user can pair in (the hot command validates the OTP itself).
    const access = loadAccess()
    const isAllowed = senderId && access.allowFrom?.includes(senderId)
    const isApproveCommand = /^\/approve_user(\s|$)/i.test(trimmed)
    if (!isAllowed && !isApproveCommand) {
        dbg("TG-USER", `DROPPED: user ${senderId} not on allowlist (text=${trimmed.slice(0, 40)})`)
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
    // /task <free-form description> — creates a new long task. Must come
    // AFTER the /task_* matchers above so they get first dibs.
    const taskNewMatch = /^\/task\s+(.+)/i.exec(trimmed)
    if (taskNewMatch) {
        return wrap(handleTaskCreate(event, core, taskNewMatch[1].trim()))
    }

    // 4. Hot-reloadable commands (e.g. /list, /new, /task, /help, ...).
    // Dispatches via the `run_hot_command` effect so the legacy
    // (ctx, bot, state) API keeps working. Commands are loaded by
    // lib/hot-commands.js at main-server startup and on /reload.
    if (trimmed.startsWith("/")) {
        const cmdMatch = /^\/(\w+)/.exec(trimmed)
        if (cmdMatch) {
            const cmdName = cmdMatch[1].toLowerCase()
            return wrap({
                stateChanges: {},
                effects: [{
                    type: "run_hot_command",
                    name: cmdName,
                    ctx: event._ctx,
                    state: buildHotCommandState(core),
                }],
            })
        }
    }

    // 5. Plain text → deliver to focused (or reply-to-targeted) session.
    //
    // Reply-to routing: if this message is a Telegram reply to a message
    // we've previously recorded in `specialData.telegramMessagesByChatId`,
    // route the reply to whichever session that message is associated
    // with. That entry's `sessionId` field is set by the `reply` tool
    // handler so the user can answer a specific session by replying-to
    // its message even when focus has moved elsewhere.
    //
    // Fallbacks, in order: stored entry → legacy `/chat_<id>` header
    // inside replyToText (for messages sent before this code landed) →
    // currently focused session.
    const focusedId = core.chatState?.focusedSessionId
    let targetSessionId = focusedId
    const replyToMid = event.replyToMessageId != null ? String(event.replyToMessageId) : null
    if (replyToMid) {
        const prior = core.specialData?.telegramMessagesByChatId?.[chatId]?.[replyToMid]
        if (prior?.sessionId && core.chatSessions?.[prior.sessionId]) {
            dbg("TG-USER", `reply-to override (state): routing to ${prior.sessionId}`)
            targetSessionId = prior.sessionId
        } else if (event.replyToText) {
            const m = /^\/(?:switch|chat)_([a-zA-Z0-9_-]+)/i.exec(event.replyToText)
            if (m) {
                const candidate = m[1]
                if (core.chatSessions?.[candidate]) {
                    dbg("TG-USER", `reply-to override (header fallback): routing to ${candidate}`)
                    targetSessionId = candidate
                } else {
                    dbg("TG-USER", `reply-to header pointed at gone session ${candidate}; falling back to focused ${focusedId}`)
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
            `Session <code>${esc(targetSessionId)}</code> has no active connection.`,
        ))
    }

    // Spinner: immediate "processing..." + tip as a single message that
    // subsequent Pre/PostToolUse hooks will EDIT (rolling buffer) rather
    // than post their own messages. This keeps notification noise down —
    // edits don't ping the user. The tooling captures the Grammy
    // message_id, records it in state, and stashes it on
    // chatSessions[sid].activeSpinner for hook handlers to find.
    const tip = getRandomTip()
    const tipLine = tip ? `\n\n<i>did you know:</i> ${tip}` : ""
    const headerHtml = `<i>processing...</i>${tipLine}`
    const bannerEffect = {
        type: "start_session_spinner",
        chatId,
        sessionId: targetSessionId,
        headerHtml,
    }

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
                    nudgedForInbound: false,
                },
            },
        },
        effects: [
            bannerEffect,
            {
                type: "deliver_channel_event",
                sessionId: targetSessionId,
                content: trimmed,
                meta: { message_id: String(messageId), chat_id: chatId },
            },
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
        dbg("TG-USER", `messageQueue full (${existing.length}); dropping oldest`)
        // Drop oldest, append new — immutable rebuild.
        nextQueue = [...existing.slice(1), entry]
        userText = "queue full, dropped oldest entry"
    } else {
        nextQueue = [...existing, entry]
    }
    return {
        stateChanges: {
            chatState: { messageQueue: nextQueue },
        },
        effects: [
            {
                type: "send_text_to_user",
                chatId,
                text: userText,
                options: { parse_mode: "HTML" },
            },
        ],
    }
}

/**
 * Handle a telegram_user_message that carries an attachment.
 *
 * Photo flow (2-phase, side-effect is the download):
 *   pass 1: emit a `download_telegram_file` effect whose followUpEvent is
 *     the same event with `_downloaded: true`. The download tooling
 *     re-enqueues the event with imagePath set.
 *   pass 2: event comes back with _downloaded === true → deliver to the
 *     focused session with `image_path` in meta.
 *
 * Other attachments: deliver directly with attachment_* meta — Claude can
 * call the download_attachment MCP tool when it's ready for the bytes.
 */
function handleAttachment(event, core) {
    const { chatId, userId, messageId, text, attachment } = event
    const trimmed = (text ?? "").trim() || `(${attachment.kind})`

    const focusedId = core.chatState?.focusedSessionId
    if (!focusedId) {
        return reply(
            chatId,
            "No focused session. Use /list to see available sessions or /new to create one.",
        )
    }
    const session = core.chatSessions?.[focusedId]
    if (!session?._conn) {
        return reply(
            chatId,
            `Focused session <code>${esc(focusedId)}</code> has no active connection.`,
        )
    }

    // ── Photo: two-phase download ─────────────────────────────────────
    if (attachment.kind === "photo") {
        if (!event._downloaded) {
            // Pass 1: kick off the download. Do NOT deliver yet. The
            // followUpEvent is the same event, marked so we skip the
            // download branch next time.
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
        // Pass 2: delivery. `event.imagePath` may be null if the download
        // failed — we still deliver so the user isn't stranded, the meta
        // just won't have image_path.
        const meta = {
            message_id: String(messageId),
            chat_id: chatId,
        }
        if (event.imagePath) {
            meta.image_path = event.imagePath
        }
        return deliverAttachment(event, core, focusedId, trimmed, meta)
    }

    // ── Non-photo attachments: deliver with attachment_* meta ─────────
    const meta = {
        message_id: String(messageId),
        chat_id: chatId,
        attachment_file_id: attachment.fileId,
        attachment_kind: attachment.kind,
    }
    if (attachment.size != null) { meta.attachment_size = attachment.size }
    if (attachment.mime != null) { meta.attachment_mime = attachment.mime }
    if (attachment.name != null) { meta.attachment_name = attachment.name }
    return deliverAttachment(event, core, focusedId, trimmed, meta)
}

function deliverAttachment(event, _core, focusedId, content, meta) {
    const { chatId, userId, messageId } = event
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
                    nudgedForInbound: false,
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

function handleSwitch(event, core, targetId) {
    const { chatId } = event
    if (!core.chatSessions?.[targetId]) {
        return reply(chatId, `Session <code>${esc(targetId)}</code> not found.`)
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
                options: { parse_mode: "HTML" },
            },
        ],
    }
}

function reply(chatId, text) {
    return {
        stateChanges: {},
        effects: [
            {
                type: "send_text_to_user",
                chatId,
                text,
                options: { parse_mode: "HTML" },
            },
        ],
    }
}

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
function formatAge(iso) {
    if (!iso) {
        return "unknown"
    }
    const then = Date.parse(iso)
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

function taskCommandLinks(taskId) {
    return [
        `/task_status_${taskId} — check status`,
        `/task_view_${taskId} — view definition of done`,
        `/task_update_${taskId} — modify the definition`,
        `/task_cancel_${taskId} — cancel the task`,
    ].join("\n")
}

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
        return reply(chatId, "Usage: <code>/task &lt;description&gt;</code>")
    }

    const focusedId = core.chatState?.focusedSessionId
    if (!focusedId) {
        return reply(chatId, "No focused session. Use /new to create one first.")
    }

    const taskId = generateTaskId(description)
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
        consecutiveIdleStops: 0,
        totalNudges: 0,
        lastNudgeAt: null,
        criticCallCount: 0,
        criticLastCallAt: null,
        criticIndecisiveRetries: 0,
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

    dbg("TG-USER", `creating long task ${taskId} for session ${focusedId}`)

    return {
        stateChanges: {
            specialData: {
                longTaskByChatId: {
                    [chatId]: {
                        [taskId]: newTask,
                    },
                },
            },
        },
        effects: [
            {
                type: "deliver_channel_event",
                sessionId: focusedId,
                content: prompt,
                meta: {},
            },
            {
                type: "send_text_to_user",
                chatId,
                text:
                    `Task started.\n\n${taskCommandLinks(taskId)}`,
                options: { parse_mode: "HTML" },
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
        return reply(chatId, `Task <code>${esc(taskId)}</code> not found.`)
    }

    const definitionStatus = task.definition ? "set" : "not yet submitted"
    const lines = [
        `<b>Task</b> <code>${esc(taskId)}</code>`,
        `<b>Title:</b> ${esc(task.title ?? "(untitled)")}`,
        `<b>State:</b> <code>${esc(task.state ?? "unknown")}</code>`,
        `<b>Worker:</b> <code>${esc(task.workerSessionId ?? "?")}</code>`,
        `<b>Created:</b> ${esc(formatAge(task.createdAt))}`,
        `<b>Definition:</b> ${esc(definitionStatus)}`,
        `<b>Critic calls:</b> ${esc(task.criticCallCount ?? 0)}`,
        `<b>Nudges:</b> ${esc(task.totalNudges ?? 0)}`,
        ``,
        taskCommandLinks(taskId),
    ]
    return reply(chatId, lines.join("\n"))
}

function handleTaskView(event, core, taskId) {
    const { chatId } = event
    const task = findTask(core, chatId, taskId)
    if (!task) {
        return reply(chatId, `Task <code>${esc(taskId)}</code> not found.`)
    }
    if (!task.definition) {
        return reply(
            chatId,
            `Task <code>${esc(taskId)}</code> has no definition yet (still in <code>defining</code> state).`,
        )
    }
    // Truncate to 3000 chars; the outbound chunker handles longer messages
    // automatically but the explicit cap keeps a single /task_view from
    // dumping a runaway definition into chat.
    const def = task.definition.slice(0, 3000)
    const truncated = task.definition.length > def.length ? "\n\n[truncated]" : ""
    const text = `<b>Definition of done — </b><code>${esc(taskId)}</code>\n<pre>${esc(def)}${esc(truncated)}</pre>`
    return reply(chatId, text)
}

function handleTaskUpdate(event, core, taskId, body) {
    const { chatId } = event
    const task = findTask(core, chatId, taskId)
    if (!task) {
        return reply(chatId, `Task <code>${esc(taskId)}</code> not found.`)
    }

    const newDefinition = (body ?? "").trim()
    if (!newDefinition) {
        // No body — show the current definition + the usage hint.
        if (!task.definition) {
            return reply(
                chatId,
                `Task <code>${esc(taskId)}</code> has no definition yet. Reply with <code>/task_update_${esc(taskId)} &lt;new text&gt;</code> to set one.`,
            )
        }
        const def = task.definition.slice(0, 3000)
        const truncated = task.definition.length > def.length ? "\n\n[truncated]" : ""
        const text =
            `<b>Current definition — </b><code>${esc(taskId)}</code>\n` +
            `<pre>${esc(def)}${esc(truncated)}</pre>\n` +
            `Reply with <code>/task_update_${esc(taskId)} &lt;new text&gt;</code> to replace.`
        return reply(chatId, text)
    }

    dbg("TG-USER", `updating definition for task ${taskId} (${newDefinition.length} chars)`)

    const workerSessionId = task.workerSessionId
    const effects = [
        {
            type: "send_text_to_user",
            chatId,
            text: `Definition updated for <code>${esc(taskId)}</code>.`,
            options: { parse_mode: "HTML" },
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
            },
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
                        [taskId]: { definition: newDefinition },
                    },
                },
            },
        },
        effects,
    }
}

function handleTaskCancel(event, core, taskId) {
    const { chatId } = event
    const task = findTask(core, chatId, taskId)
    if (!task) {
        return reply(chatId, `Task <code>${esc(taskId)}</code> not found.`)
    }

    dbg("TG-USER", `cancelling long task ${taskId}`)

    const workerSessionId = task.workerSessionId
    const effects = [
        {
            type: "send_text_to_user",
            chatId,
            text: `Task <code>${esc(taskId)}</code> cancelled.`,
            options: { parse_mode: "HTML" },
        },
        {
            type: "cold_append",
            stream: "long-tasks",
            entry: {
                event: "cancelled",
                taskId,
                chatId,
                sessionId: workerSessionId,
            },
        },
    ]

    if (workerSessionId) {
        effects.push({
            type: "deliver_channel_event",
            sessionId: workerSessionId,
            content:
                `[long task ${taskId} — cancelled]\n` +
                `The user has cancelled this task. Stop working on it.`,
            meta: {},
        })
    }

    // Remove the entry from the hot map (undefined = delete under
    // mergeSessionData). History lives in cold-storage/long-tasks.jsonl
    // via the `cold_append` effect emitted above, matching the
    // critic-verdict "certified" flow's lifecycle.
    return {
        stateChanges: {
            specialData: {
                longTaskByChatId: {
                    [chatId]: {
                        [taskId]: undefined,
                    },
                },
            },
        },
        effects,
    }
}

/**
 * Build the `state` object that legacy hot commands expect.
 *
 * The old architecture passed `(ctx, bot, state)` to each hot command,
 * where `state` exposed the server's session registry and a handful of
 * utility functions. To avoid rewriting 18 commands right now, we
 * recreate the shape here. Mutating helpers (`setFocusedSession`,
 * `setTitle`, `setPaused`) write directly into core state — the event
 * loop's single-writer guarantee is bypassed here as a pragmatic
 * bridging concession until hot commands are ported to return Actions.
 *
 * Previously title/paused state lived on a `globalThis.__tgCommandState`
 * object owned by commands/_shared.js; that's been deleted so the hot
 * session registry (core.chatSessions) is the single source of truth.
 */
function buildHotCommandState(core) {
    function mutateSession(id, patch) {
        const sessions = core.chatSessions
        if (sessions?.[id]) {
            sessions[id] = { ...sessions[id], ...patch }
        }
    }
    return {
        allSessions() {
            return Object.values(core.chatSessions ?? {}).map(s => ({
                id: s.id,
                pid: s.pid,
                cwd: s.cwd,
                title: s.title ?? null,
                gitBranch: s.gitBranch ?? null,
                dtachSocket: s.dtachSocket,
                connectedAt: s.connectedAt,
                lastActive: s.lastActive ?? null,
                paused: s.paused === true,
                // recentMessages used by /list formatting
                recentMessages: s.recentMessages ?? [],
            }))
        },
        get focusedSessionId() {
            return core.chatState?.focusedSessionId ?? null
        },
        setFocusedSession(id) {
            // Direct mutation — bridging concession. A proper port would
            // have the command return an Action we merge through core.
            if (core.chatState) {
                core.chatState = { ...core.chatState, focusedSessionId: id }
            }
        },
        setTitle(id, title) {
            mutateSession(id, { title })
        },
        setPaused(id, paused) {
            mutateSession(id, { paused: paused === true })
        },
        homedir() {
            return Deno.env.get("HOME")
        },
        loadAccess() {
            // Thin wrapper so legacy commands can read the access.json
            // allowlist without depending on the event-loop's import graph.
            return loadAccess()
        },
        /**
         * Look up a pending OTP stashed via the `cli_command` kind
         * `set_pending_otp`. Returns the entry ({ createdAt, chatId })
         * or null. Replaces the deleted pending_otp.json file path.
         */
        getPendingOtp(token) {
            return core.chatState?.pendingOtps?.[token] ?? null
        },
        /**
         * Remove a pending OTP (single-use). Direct mutation — bridging
         * concession, same as `setFocusedSession`. A proper port would
         * route this through a state patch.
         */
        consumePendingOtp(token) {
            const pending = core.chatState?.pendingOtps
            if (pending && token in pending) {
                const next = { ...pending }
                delete next[token]
                core.chatState = { ...core.chatState, pendingOtps: next }
            }
        },
        letClaudeHandle(ctx, overrideText) {
            // Legacy escape hatch: forward the current message to the
            // focused session as if it were plain text. We re-enqueue a
            // synthetic telegram_user_message so the normal text-fallthrough
            // path handles it. Skip the leading `/` so we don't bounce
            // back into hot-command dispatch.
            const inner = String(overrideText ?? ctx.message?.text ?? "").replace(/^\/\w+\s*/, "")
            if (!inner) {
                return
            }
            core.enqueueEvent?.({
                type: "telegram_user_message",
                ts: Date.now(),
                chatId: String(ctx.chat?.id ?? ""),
                userId: String(ctx.from?.id ?? ""),
                username: ctx.from?.username ?? null,
                messageId: ctx.message?.message_id,
                text: inner,
                replyToMessageId: ctx.message?.reply_to_message?.message_id ?? null,
                replyToText: ctx.message?.reply_to_message?.text ?? null,
                attachment: null,
                chatType: ctx.chat?.type,
                _ctx: ctx,
            })
        },
    }
}
