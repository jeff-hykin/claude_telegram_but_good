// ---------------------------------------------------------------------------
// claude_channel_tool_request handler.
//
// Fired by the IPC translator whenever a Claude session's shim invokes one
// of the MCP tools (reply, react, edit_message, download_attachment,
// new_command, reload, set_title). The handler is PURE — it returns an
// Action describing the side-effect to run plus an immediate ipc_respond
// effect that hands a tool_response back to the shim.
//
// We're optimistic: the Grammy outbound effects are queued and we reply
// "ok" immediately. If the actual Grammy call later fails, the tooling
// layer logs via dbg() but no error is propagated back to the worker.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { paths } = await versionedImport("../paths.js", import.meta)
const { generateUniqueTaskId, taskCommandLinks } = await versionedImport("../long-task-actions.js", import.meta)
const { escapeHtml: esc } = await versionedImport("../pure/html.js", import.meta)
const { loadAccess } = await versionedImport("../access.js", import.meta)

export default function handle(event, core) {
    const { toolName, args = {}, requestId, _conn, sessionId } = event

    if (!toolName || typeof toolName !== "string") {
        return replyError(_conn, requestId, "missing toolName")
    }

    dbg("CHANNEL", `tool=${toolName} session=${sessionId}`)

    switch (toolName) {
        case "reply":                        return handleReply(event, core)
        case "react":                        return handleReact(event, core)
        case "edit_message":                 return handleEdit(event, core)
        case "download_attachment":          return handleDownload(event, core)
        case "new_command":                  return handleNewCommand(event, core)
        case "reload":                       return handleReload(event, core)
        case "set_title":                    return handleSetTitle(event, core)
        case "start_long_well_defined_task": return handleStartLongWellDefinedTask(event, core)
        case "get_topic_memory":             return handleGetTopicMemory(event, core)
        case "list_sessions":               return handleListSessions(event, core)
        case "tell_session":                return handleTellSession(event, core)
        case "set_reminder":                return handleSetReminder(event, core)
        case "set_repeat":                  return handleSetRepeat(event, core)
        case "cancel_reminder":             return handleCancelReminder(event, core)
        case "snooze_reminder":             return handleSnoozeReminder(event, core)
        case "watch_file":                  return handleWatchFile(event, core)
        default:
            dbg("CHANNEL", `unknown tool: ${toolName}`)
            return replyError(_conn, requestId, `unknown tool: ${toolName}`)
    }
}

// ── reply ──────────────────────────────────────────────────────────────

function handleReply(event, core) {
    const { args = {}, requestId, _conn, sessionId, ts } = event
    const chatId = args.chat_id
    const text = args.text

    if (!chatId) {
        return replyError(_conn, requestId, "reply: missing chat_id")
    }
    if (typeof text !== "string") {
        return replyError(_conn, requestId, "reply: missing text")
    }

    const options = buildFormatOptions(args.format)
    if (args.reply_to) {
        options.reply_to_message_id = args.reply_to
    }

    // Prepend a routing header so every agent message tells the user
    // which session it came from and gives them a one-tap `/chat_<id>`
    // command to reply back to that specific session. The header is
    // visual-only — specialData.telegramMessagesByChatId is still the
    // source of truth for reply-to routing.
    const headeredText = makeChatHeader(sessionId, core, args.format) + text

    const effects = []
    // recordAs is read by the outbound tooling after Grammy returns a
    // Message; it stamps this outbound into `specialData.telegramMessagesByChatId`
    // so later reply-to routing and spinner rolling-buffer edits can
    // look up the bot's own messages by id.
    const recordAs = {
        from: "agent",
        kind: "regular",
        sessionId: sessionId ?? null,
        text: text.slice(0, 500),
        ts: ts ?? Date.now(),
    }

    // Command center dual delivery: if the session is bound to a topic,
    // also send the reply to the topic (or only to the topic, depending
    // on the outputMode config). The topic copy omits the routing header
    // since the topic IS the routing context.
    //
    // When the reply's chatId IS the command center group, the "DM" path
    // would land in the General topic (no thread_id), duplicating the
    // message. In that case, skip the un-threaded send and only deliver
    // to the bound topic.
    const cc = core.chatState?.commandCenter ?? {}
    const topicThreadId = sessionId ? cc.topicMap?.[sessionId] : null
    const outputMode = cc.outputMode ?? "both"
    const access = loadAccess()
    const ccChatId = access.commandCenterChatId
    const replyIsToCommandCenter = ccChatId && String(chatId) === String(ccChatId)

    // Should we send the un-threaded copy? Yes unless it would land in
    // the command center's General topic (which happens when chatId IS
    // the cc group and we have a topic thread to use instead).
    const sendDmCopy = (!topicThreadId || outputMode === "dm" || outputMode === "both")
        && !(replyIsToCommandCenter && topicThreadId)

    if (Array.isArray(args.files) && args.files.length > 0) {
        // Send each file as its own document. Caption attached only to
        // the first file so the text isn't repeated. The first file's
        // caption ALSO carries the routing header so reply-to-file works.
        for (let i = 0; i < args.files.length; i++) {
            const filePath = args.files[i]
            if (typeof filePath !== "string" || filePath.length === 0) {
                continue
            }
            const filename = filePath.split("/").pop() || filePath
            if (sendDmCopy) {
                effects.push({
                    type: "send_file_to_user",
                    chatId,
                    filePath,
                    filename,
                    caption: i === 0 ? headeredText : undefined,
                    recordAs,
                })
            }
            if (topicThreadId && (outputMode === "group" || outputMode === "both")) {
                if (ccChatId) {
                    effects.push({
                        type: "send_file_to_user",
                        chatId: ccChatId,
                        filePath,
                        filename,
                        caption: i === 0 ? text : undefined,
                        options: { message_thread_id: Number(topicThreadId) },
                        recordAs: { ...recordAs, kind: "topic_mirror" },
                    })
                }
            }
        }
    } else {
        if (sendDmCopy) {
            effects.push({
                type: "send_text_to_user",
                chatId,
                text: headeredText,
                options,
                recordAs,
            })
        }
        if (topicThreadId && (outputMode === "group" || outputMode === "both")) {
            if (ccChatId) {
                effects.push({
                    type: "send_text_to_user",
                    chatId: ccChatId,
                    text: text,
                    options: { ...buildFormatOptions(args.format), message_thread_id: Number(topicThreadId) },
                    recordAs: { ...recordAs, kind: "topic_mirror" },
                })
            }
        }
    }

    // Cold-storage trail of agent-side messages, capped to 500 chars so
    // the jsonl doesn't grow unbounded for verbose replies.
    effects.push({
        type: "cold_append",
        stream: "messages",
        entry: {
            from: "agent",
            chatId,
            text: text.slice(0, 500),
            sessionId,
            ts,
        },
    })

    // No clear_session_spinner effect emitted — the built-in spinner
    // policy in main-event-processor.js detects reply tool calls and
    // freezes the spinner after the outbound effects have fired.

    // Optimistic ipc_respond — added last so the shim sees success even
    // before Grammy fires the message.
    effects.push(...replyOk(_conn, requestId, "queued"))

    // Record the outbound so the Stop-hook nudge watchdog can tell that
    // the worker has responded since the last inbound. If the session's
    // pending nudge was a reply reminder, clear it — the worker just
    // fulfilled the reply obligation. Long-task nudges (taskCheck) are
    // left alone: the task is still running, reply tool call or not.
    const sessionPatch = sessionId
        ? { lastOutboundAt: ts }
        : null
    if (sessionPatch) {
        const existing = core?.chatSessions?.[sessionId]
        if (existing?.pendingNudgeAction === "askAgentToSendChatMessage") {
            sessionPatch.pendingNudgeAction = "none"
        }
    }
    const stateChanges = sessionPatch
        ? { chatSessions: { [sessionId]: sessionPatch } }
        : {}

    return {
        stateChanges,
        effects,
    }
}

// ── react ──────────────────────────────────────────────────────────────

function handleReact(event, _core) {
    const { args = {}, requestId, _conn } = event
    const chatId = args.chat_id
    const messageId = args.message_id
    const emoji = args.emoji

    if (!chatId) {
        return replyError(_conn, requestId, "react: missing chat_id")
    }
    if (!messageId) {
        return replyError(_conn, requestId, "react: missing message_id")
    }
    if (typeof emoji !== "string") {
        return replyError(_conn, requestId, "react: missing emoji")
    }

    return {
        stateChanges: {},
        effects: [
            {
                type: "send_reaction",
                chatId,
                messageId,
                emoji,
            },
            ...replyOk(_conn, requestId, "queued"),
        ],
    }
}

// ── edit_message ───────────────────────────────────────────────────────

function handleEdit(event, _core) {
    const { args = {}, requestId, _conn } = event
    const chatId = args.chat_id
    const messageId = args.message_id
    const text = args.text

    if (!chatId) {
        return replyError(_conn, requestId, "edit_message: missing chat_id")
    }
    if (!messageId) {
        return replyError(_conn, requestId, "edit_message: missing message_id")
    }
    if (typeof text !== "string") {
        return replyError(_conn, requestId, "edit_message: missing text")
    }

    const options = buildFormatOptions(args.format)

    return {
        stateChanges: {},
        effects: [
            {
                type: "edit_telegram_message",
                chatId,
                messageId,
                text,
                options,
            },
            ...replyOk(_conn, requestId, "queued"),
        ],
    }
}

// ── download_attachment ────────────────────────────────────────────────

function handleDownload(event, _core) {
    const { args = {}, requestId, _conn } = event
    const fileId = args.file_id

    if (typeof fileId !== "string" || fileId.length === 0) {
        return replyError(_conn, requestId, "download_attachment: missing file_id")
    }

    // Two-phase: kick off the download, then reply to Claude from the
    // follow-up handler once the bytes are local. The followUpEvent is
    // re-enqueued by `lib/effects/telegram-download.js` with `imagePath`
    // set to the saved path (or null on failure).
    const followUpEvent = {
        type: "download_complete_for_tool",
        fileId,
        requestId,
        _conn,
    }

    return {
        stateChanges: {},
        effects: [
            {
                type: "download_telegram_file",
                fileId,
                followUpEvent,
            },
        ],
    }
}

// ── new_command ────────────────────────────────────────────────────────

function handleNewCommand(event, _core) {
    const { args = {}, requestId, _conn } = event
    const filename = args.filename
    const code = args.code

    if (typeof filename !== "string" || !filename.endsWith(".js")) {
        return replyError(_conn, requestId, "new_command: filename must end in .js")
    }
    if (typeof code !== "string" || code.length === 0) {
        return replyError(_conn, requestId, "new_command: missing code")
    }
    // Reject path traversal — only a flat filename allowed under the
    // custom commands directory.
    if (filename.includes("/") || filename.includes("..")) {
        return replyError(_conn, requestId, "new_command: filename must not contain '/' or '..'")
    }

    const targetPath = `${paths.CUSTOM_COMMANDS_DIR}/${filename}`

    return {
        stateChanges: {},
        effects: [
            {
                type: "write_file",
                path: targetPath,
                content: code,
            },
            // Reload immediately so the new command becomes available
            // without the user having to send /reload manually.
            { type: "reload_hot_commands" },
            ...replyOk(
                _conn,
                requestId,
                `command written to ${targetPath} and reloaded`,
            ),
        ],
    }
}

// ── reload ─────────────────────────────────────────────────────────────

function handleReload(event, _core) {
    const { requestId, _conn } = event
    return {
        stateChanges: {},
        effects: [
            { type: "reload_hot_commands" },
            ...replyOk(_conn, requestId, "Hot commands reloaded."),
        ],
    }
}

// ── set_title ──────────────────────────────────────────────────────────

function handleSetTitle(event, core) {
    const { args = {}, requestId, _conn, sessionId } = event
    const rawTitle = args.title

    if (!sessionId) {
        return replyError(_conn, requestId, "set_title: missing sessionId on event")
    }

    // Use the supplied title only if it's a non-empty trimmed string;
    // otherwise derive one from the session's cwd basename + git branch.
    // Lets Claude call set_title with `""` to mean "pick something
    // sensible based on context."
    let title
    if (typeof rawTitle === "string" && rawTitle.trim().length > 0) {
        title = rawTitle.trim()
    } else {
        const session = core?.chatSessions?.[sessionId]
        title = deriveTitle(session)
    }

    // If the session is bound to a command center topic, sync the
    // topic name to match the new title.
    const effects = [...replyOk(_conn, requestId, `title set to "${title}"`)]
    const cc = core.chatState?.commandCenter ?? {}
    const topicThreadId = cc.topicMap?.[sessionId]
    if (topicThreadId) {
        const access = loadAccess()
        const ccChatId = access.commandCenterChatId
        if (ccChatId) {
            effects.push({
                type: "rename_thread",
                chatId: ccChatId,
                threadId: topicThreadId,
                title,
            })
        }
    }

    return {
        stateChanges: {
            chatSessions: {
                [sessionId]: { title },
            },
        },
        effects,
    }
}

function deriveTitle(session) {
    if (!session) { return "session" }
    const cwd = session.cwd ?? ""
    const base = cwd.split("/").filter(Boolean).pop() ?? "session"
    const branch = session.gitBranch ? ` (${session.gitBranch})` : ""
    return `${base}${branch}`
}

// ── set_reminder / set_repeat / cancel / snooze / watch_file ────────

function handleSetReminder(event, core) {
    const { args = {}, requestId, _conn, sessionId } = event
    const message = args.message
    const delaySec = args.delay_seconds
    if (!message || typeof delaySec !== "number" || delaySec <= 0) {
        return replyError(_conn, requestId, "set_reminder: missing message or delay_seconds")
    }
    const id = `rem_${Date.now().toString(36)}`
    dbg("CHANNEL", `set_reminder ${id} for ${sessionId} in ${delaySec}s`)
    return {
        stateChanges: {},
        effects: [
            ...replyOk(_conn, requestId, JSON.stringify({ id, fires_in: `${delaySec}s` })),
            {
                type: "set_timer",
                delayMs: delaySec * 1000,
                event: {
                    type: "agent_timer_fire",
                    sessionId,
                    timerId: id,
                    message,
                    kind: "reminder",
                },
            },
        ],
    }
}

function handleSetRepeat(event, core) {
    const { args = {}, requestId, _conn, sessionId } = event
    const message = args.message
    const intervalSec = args.interval_seconds
    const maxCount = args.max_count ?? null
    if (!message || typeof intervalSec !== "number" || intervalSec <= 0) {
        return replyError(_conn, requestId, "set_repeat: missing message or interval_seconds")
    }
    const id = `rpt_${Date.now().toString(36)}`
    dbg("CHANNEL", `set_repeat ${id} for ${sessionId} every ${intervalSec}s`)
    return {
        stateChanges: {},
        effects: [
            ...replyOk(_conn, requestId, JSON.stringify({ id, interval: `${intervalSec}s`, max_count: maxCount })),
            {
                type: "set_timer",
                delayMs: intervalSec * 1000,
                event: {
                    type: "agent_timer_fire",
                    sessionId,
                    timerId: id,
                    message,
                    kind: "repeat",
                    intervalMs: intervalSec * 1000,
                    maxCount,
                    fireCount: 0,
                },
            },
        ],
    }
}

function handleCancelReminder(event, core) {
    const { args = {}, requestId, _conn, sessionId } = event
    const id = args.id
    if (!id) {
        return replyError(_conn, requestId, "cancel_reminder: missing id")
    }
    // Mark cancelled in session state so the fire handler skips it.
    const session = core.chatSessions?.[sessionId]
    const cancelled = { ...(session?.cancelledTimers ?? {}), [id]: true }
    dbg("CHANNEL", `cancel_reminder ${id} for ${sessionId}`)
    return {
        stateChanges: {
            chatSessions: {
                [sessionId]: { cancelledTimers: cancelled },
            },
        },
        effects: replyOk(_conn, requestId, `cancelled ${id}`),
    }
}

function handleSnoozeReminder(event, core) {
    const { args = {}, requestId, _conn, sessionId } = event
    const id = args.id
    const delaySec = args.delay_seconds
    if (!id || typeof delaySec !== "number" || delaySec <= 0) {
        return replyError(_conn, requestId, "snooze_reminder: missing id or delay_seconds")
    }
    // Look up the last message from the timer's state. If we can't find
    // it, use a generic message.
    const lastMsg = core.chatSessions?.[sessionId]?._lastTimerMessages?.[id] ?? `[snoozed reminder ${id}]`
    dbg("CHANNEL", `snooze_reminder ${id} for ${sessionId} by ${delaySec}s`)
    return {
        stateChanges: {},
        effects: [
            ...replyOk(_conn, requestId, JSON.stringify({ id, snoozed: `${delaySec}s` })),
            {
                type: "set_timer",
                delayMs: delaySec * 1000,
                event: {
                    type: "agent_timer_fire",
                    sessionId,
                    timerId: id,
                    message: lastMsg,
                    kind: "reminder",
                },
            },
        ],
    }
}

function handleWatchFile(event, core) {
    const { args = {}, requestId, _conn, sessionId } = event
    const filePath = args.path
    const message = args.message ?? `[file changed: ${filePath}]`
    const timeoutSec = args.timeout_seconds ?? 3600
    if (!filePath) {
        return replyError(_conn, requestId, "watch_file: missing path")
    }
    const id = `watch_${Date.now().toString(36)}`
    dbg("CHANNEL", `watch_file ${id} for ${sessionId}: ${filePath}`)

    // Start a Deno.watchFs watcher in the background. When it detects
    // a change, enqueue a channel event and close the watcher. This
    // is a bridging concession — the watcher runs as a background
    // async loop outside the pure event handler contract.
    ;(async () => {
        const timeoutMs = timeoutSec * 1000
        const deadline = Date.now() + timeoutMs
        try {
            const watcher = Deno.watchFs(filePath)
            const timeoutId = setTimeout(() => {
                dbg("FILE-WATCH", `${id} timed out after ${timeoutSec}s`)
                watcher.close()
                const session = core.chatSessions?.[sessionId]
                if (session?.cancelledTimers?.[id]) { return }
                core.enqueueEvent?.({
                    type: "agent_file_watch_result",
                    sessionId,
                    watchId: id,
                    filePath,
                    message: `[file watch ${id} timed out after ${timeoutSec}s — no changes detected on ${filePath}]`,
                    status: "timeout",
                })
            }, timeoutMs)

            for await (const evt of watcher) {
                // Check cancellation.
                const session = core.chatSessions?.[sessionId]
                if (session?.cancelledTimers?.[id]) {
                    dbg("FILE-WATCH", `${id} cancelled`)
                    watcher.close()
                    clearTimeout(timeoutId)
                    return
                }
                dbg("FILE-WATCH", `${id} detected ${evt.kind} on ${filePath}`)
                watcher.close()
                clearTimeout(timeoutId)
                core.enqueueEvent?.({
                    type: "agent_file_watch_result",
                    sessionId,
                    watchId: id,
                    filePath,
                    message,
                    status: "changed",
                    changeKind: evt.kind,
                })
                return
            }
        } catch (e) {
            dbg("FILE-WATCH", `${id} watcher error:`, e)
            core.enqueueEvent?.({
                type: "agent_file_watch_result",
                sessionId,
                watchId: id,
                filePath,
                message: `[file watch ${id} error: ${String(e).slice(0, 200)}]`,
                status: "error",
            })
        }
    })()

    return {
        stateChanges: {},
        effects: replyOk(_conn, requestId, JSON.stringify({ id, watching: filePath, timeout: `${timeoutSec}s` })),
    }
}

// ── list_sessions ────────────────────────────────────────────────────

function handleListSessions(event, core) {
    const { requestId, _conn } = event
    const sessions = core.chatSessions ?? {}
    const cc = core.chatState?.commandCenter ?? {}
    const result = []
    for (const [sid, s] of Object.entries(sessions)) {
        if (!s) { continue }
        const threadId = cc.topicMap?.[sid] ?? null
        const topicName = threadId ? (cc.topicNames?.[threadId] ?? null) : null
        result.push({
            id: sid,
            title: s.title ?? null,
            topicName,
            status: s.status ?? "idle",
            pid: s.pid ?? null,
            cwd: s.cwd ?? null,
            gitBranch: s.gitBranch ?? null,
            connected: !!s._conn,
            lastActive: s.lastActive ?? null,
            connectedAt: s.connectedAt ?? null,
        })
    }
    // Most recently active first
    result.sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))
    return {
        stateChanges: {},
        effects: replyOk(_conn, requestId, JSON.stringify({ sessions: result })),
    }
}

// ── tell_session ─────────────────────────────────────────────────────

/**
 * Resolve a flexible address (session ID, topic name, or title substring)
 * to exactly one connected session. Returns { session, error }.
 */
function resolveTarget(address, core) {
    const sessions = core.chatSessions ?? {}
    const cc = core.chatState?.commandCenter ?? {}

    // 1) exact session ID
    if (sessions[address]?._conn) {
        return { session: sessions[address] }
    }

    // 2) topic name → find the connected session mapped to that topic
    const topicMatches = []
    for (const [sid, s] of Object.entries(sessions)) {
        if (!s?._conn) { continue }
        const threadId = cc.topicMap?.[sid] ?? null
        const topicName = threadId ? (cc.topicNames?.[threadId] ?? null) : null
        if (topicName && topicName.toLowerCase() === address.toLowerCase()) {
            topicMatches.push(s)
        }
    }
    if (topicMatches.length === 1) { return { session: topicMatches[0] } }
    if (topicMatches.length > 1) {
        const ids = topicMatches.map(s => s.id).join(", ")
        return { error: `ambiguous: ${topicMatches.length} sessions in topic "${address}" (${ids}). Use a session ID.` }
    }

    // 3) title substring (case-insensitive)
    const needle = address.toLowerCase()
    const titleMatches = []
    for (const [sid, s] of Object.entries(sessions)) {
        if (!s?._conn) { continue }
        if (s.title && s.title.toLowerCase().includes(needle)) {
            titleMatches.push(s)
        }
    }
    if (titleMatches.length === 1) { return { session: titleMatches[0] } }
    if (titleMatches.length > 1) {
        const ids = titleMatches.map(s => `${s.id} (${s.title})`).join(", ")
        return { error: `ambiguous: ${titleMatches.length} sessions match title "${address}" (${ids}). Use a session ID.` }
    }

    return { error: `no connected session matches "${address}" (tried session ID, topic name, title)` }
}

/**
 * Look up the topic name for a session (or null if unbound).
 */
function sessionTopicName(sessionId, core) {
    const cc = core.chatState?.commandCenter ?? {}
    const threadId = cc.topicMap?.[sessionId] ?? null
    return threadId ? (cc.topicNames?.[threadId] ?? null) : null
}

function handleTellSession(event, core) {
    const { args = {}, requestId, _conn, sessionId } = event
    // support both old "target_session_id" and new "target" param
    const address = args.target || args.target_session_id
    const text = args.text

    if (!address) {
        return replyError(_conn, requestId, "tell_session: missing target (session ID, topic name, or title)")
    }
    if (!text) {
        return replyError(_conn, requestId, "tell_session: missing text")
    }

    const { session: target, error } = resolveTarget(address, core)
    if (error) {
        return replyError(_conn, requestId, `tell_session: ${error}`)
    }

    const targetId = target.id
    const fromTopic = sessionTopicName(sessionId, core) || "_unbound"
    const toTopic = sessionTopicName(targetId, core) || "_unbound"

    const logEntry = {
        ts: new Date().toISOString(),
        from: { sessionId, topicName: fromTopic },
        to: { sessionId: targetId, topicName: toTopic },
        text,
        source: "tell_session",
    }

    // deduplicate topic names for logging (don't double-log if same topic)
    const logTopics = [...new Set([fromTopic, toTopic])]

    return {
        stateChanges: {},
        effects: [
            ...replyOk(_conn, requestId, `message delivered to ${targetId} (resolved from "${address}")`),
            {
                type: "deliver_channel_event",
                sessionId: targetId,
                content: `[from ${fromTopic}/${sessionId} — reply with: tell_session target="${sessionId}" text="..."]\n${text}`,
                meta: { source: "tell_session", fromSession: sessionId, fromTopic },
            },
            {
                type: "log_inter_session_message",
                entry: logEntry,
                topicNames: logTopics,
            },
        ],
    }
}

// ── get_topic_memory ──────────────────────────────────────────────────

function handleGetTopicMemory(event, core) {
    const { requestId, _conn, sessionId } = event
    if (!sessionId) {
        return replyError(_conn, requestId, "get_topic_memory: missing sessionId")
    }

    const cc = core.chatState?.commandCenter ?? {}
    const threadId = cc.topicMap?.[sessionId]
    const topicName = threadId ? (cc.topicNames?.[threadId] ?? null) : null

    if (!topicName) {
        return {
            stateChanges: {},
            effects: replyOk(_conn, requestId, JSON.stringify({
                found: false,
                message: "This session is not bound to a command center topic.",
                tip: "Topic memory is created when a session is spawned via /refresh in a command center topic.",
            })),
        }
    }

    const memoryFile = paths.topicMemoryFile(topicName)
    let content = null
    try {
        content = Deno.readTextFileSync(memoryFile)
    } catch (e) {
        if (e.code !== "ENOENT") {
            dbg("CHANNEL", `get_topic_memory read failed:`, e)
        }
    }

    // Ensure the topic directory exists so the session can write.
    try {
        Deno.mkdirSync(paths.topicDir(topicName), { recursive: true })
    } catch (e) {
        dbg("CHANNEL", `get_topic_memory mkdir failed:`, e)
    }

    return {
        stateChanges: {},
        effects: replyOk(_conn, requestId, JSON.stringify({
            found: true,
            topicName,
            path: memoryFile,
            content: content ?? "",
            tip: "Update this file regularly as you work. It persists across session refreshes.",
        })),
    }
}

// ── start_long_well_defined_task ───────────────────────────────────────
//
// Agent-initiated long task. Unlike the user-driven `/task` flow (which
// creates a task in state="defining" and asks the worker to draft a DoD),
// this tool locks the definition at creation time — the agent already has
// a concrete DoD in mind, that's the whole point of calling THIS tool
// instead of /task. Task lands in state="in_progress" immediately.
//
// Same one-task-per-session invariant as the /task flow: refuse if the
// session already owns an active long task (the caller should finish or
// cancel the existing one first). Errors return via tool_response with
// isError=true so the agent can catch+retry without taking the session
// down.

function handleStartLongWellDefinedTask(event, core) {
    const { args = {}, requestId, _conn, sessionId, ts } = event
    const chatId = typeof args.chat_id === "string" ? args.chat_id.trim() : ""
    const description = typeof args.description === "string" ? args.description.trim() : ""
    const definition = typeof args.definition_of_done === "string" ? args.definition_of_done.trim() : ""

    if (!sessionId) {
        return replyError(_conn, requestId, "start_long_well_defined_task: no sessionId on event")
    }
    if (!chatId) {
        return replyError(_conn, requestId, "start_long_well_defined_task: chat_id is required")
    }
    if (!description) {
        return replyError(_conn, requestId, "start_long_well_defined_task: description is required")
    }
    if (!definition) {
        return replyError(_conn, requestId, "start_long_well_defined_task: definition_of_done is required and must be non-empty markdown")
    }

    // One-task-per-session invariant. Matches /task behavior in
    // chat-user.js. Dangling-pointer defense: if longTaskId is set but
    // the task entry is missing from specialData, treat the pointer as
    // stale and fall through (the new task overwrites it).
    const session = core.chatSessions?.[sessionId]
    const existingTaskId = session?.longTaskId
    if (existingTaskId) {
        const existing = core.specialData?.longTaskByChatId?.[chatId]?.[existingTaskId]
        if (existing) {
            return replyError(
                _conn,
                requestId,
                `Session ${sessionId} already owns task ${existingTaskId} (state=${existing.state}). ` +
                `Finish or cancel it before starting a new one.`,
            )
        }
        dbg("CHANNEL", `stale longTaskId=${existingTaskId} on session ${sessionId}; overwriting with new task`)
    }

    const taskId = generateUniqueTaskId(core)
    const title = description.split(/\s+/).slice(0, 6).join(" ")
    const createdAt = new Date().toISOString()
    const taskDirAbs = paths.longTaskDir(taskId)

    const newTask = {
        id: taskId,
        title,
        originalPrompt: description,
        createdAt,
        // Skip the "defining" state entirely — the agent committed the
        // DoD as part of the call, so we jump straight to in_progress.
        state: "in_progress",
        workerSessionId: sessionId,
        definition,
        consecutiveIdleStops: 0,
        totalNudges: 0,
        lastNudgeAt: null,
        criticCallCount: 0,
        criticLastCallAt: null,
    }

    // Flip the session into taskCheck mode so the Stop-hook nudge
    // watchdog starts watching it. We don't need the full
    // activateWaitingState dance — the session is currently mid-tool
    // call (status=working), and setting pendingNudgeAction here is
    // what activateWaitingState would do in that branch anyway.
    const sessionPatch = {
        longTaskId: taskId,
        pendingNudgeAction: "taskCheck",
    }

    dbg("CHANNEL", `agent-initiated long task ${taskId} for session ${sessionId} in chat ${chatId}`)

    // Response text for the agent — explains the deliverables it's
    // expected to write and the channel-delivered critic verdict that
    // will land later. Keep this terse but unambiguous: the agent will
    // not be reminded of these paths after the call returns.
    const agentInstructions = [
        `Long task ${taskId} started.`,
        ``,
        `Definition of done is locked. State is now "in_progress".`,
        ``,
        `Write your working notes as you go:`,
        `  context.md  → ${taskDirAbs}/context.md`,
        `  progress.md → ${taskDirAbs}/progress.md`,
        ``,
        `When you believe you're done, write your final report to:`,
        `  report.md   → ${taskDirAbs}/report.md`,
        ``,
        `Once report.md exists, a critic will independently review it against your`,
        `definition of done. The critic's verdict (certified, needs-revision, or`,
        `other) will be delivered back to you as a message via the channel`,
        `notifications system — the same way inbound Telegram messages arrive.`,
        `Keep working until you receive a "certified" verdict from the channel.`,
        ``,
        `Status command for the user: /task_status_${taskId}`,
    ].join("\n")

    const stateChanges = {
        specialData: {
            longTaskByChatId: {
                [chatId]: {
                    [taskId]: newTask,
                },
            },
        },
        chatSessions: {
            [sessionId]: sessionPatch,
        },
    }

    const effects = [
        // Pre-create the task working directory so the agent's first
        // Write tool call doesn't have to mkdir its own parent.
        { type: "mkdir", path: taskDirAbs },
        // Backup the definition to disk, same as long-task-definition-submitted.js.
        {
            type: "write_file",
            path: paths.longTaskDefinitionBackupFile(taskId),
            content: definition,
        },
        // User-facing Telegram confirmation. Mirrors the "Task confirmed
        // to be understood" message from long-task-definition-submitted.js
        // since we're skipping that handler entirely.
        {
            type: "send_text_to_user",
            chatId,
            text:
                `Agent started long task <code>${esc(taskId)}</code>:` +
                `\n\n<b>${esc(title)}</b>` +
                `\n\n` +
                taskCommandLinks(taskId),
            options: { parse_mode: "HTML" },
        },
        // Cold-storage trail — two entries (created + definition_locked)
        // so downstream history queries see the same events they'd see
        // for the /task flow.
        {
            type: "cold_append",
            stream: "long-tasks",
            entry: {
                event: "created",
                taskId,
                chatId,
                sessionId,
                title,
                triggeredBy: "agent",
            },
        },
        {
            type: "cold_append",
            stream: "long-tasks",
            entry: {
                event: "definition_locked",
                taskId,
                chatId,
                sessionId,
                definitionLength: definition.length,
                triggeredBy: "agent",
            },
        },
        ...replyOk(_conn, requestId, agentInstructions),
    ]

    return { stateChanges, effects }
}

// ── helpers ────────────────────────────────────────────────────────────

/**
 * Build a Grammy sendMessage `options` object from the requested format.
 * Default is plain text (no parse_mode). HTML uses parse_mode: "HTML".
 * Markdown is intentionally ignored — Telegram's Markdown parsers are
 * unreliable, see CLAUDE.md.
 */
function buildFormatOptions(format) {
    if (format === "html") {
        return { parse_mode: "HTML" }
    }
    return {}
}

/**
 * Produce the routing-header line prepended to every agent reply.
 *
 * Shape:
 *   /chat_<sessionId> (<title>)\n\n
 *
 * The `/chat_<id>` part is emitted as PLAIN text (never wrapped in
 * <code> or <pre>) so Telegram auto-detects it as a bot command and
 * makes it tappable — tapping sends it as a message. Wrapping it in
 * <code> would turn it into tap-to-copy, which is not what we want.
 *
 * If the session has no distinct title, the parenthetical is omitted
 * so we don't render a redundant `/chat_CalmLion (CalmLion)`. In HTML
 * format the title is escaped + italicized for a subtle visual tag.
 *
 * Returns "" when there's no sessionId to route to — the header would
 * be useless in that case.
 */
function makeChatHeader(sessionId, core, format) {
    if (!sessionId) { return "" }
    const session = core?.chatSessions?.[sessionId]
    const rawTitle = typeof session?.title === "string" ? session.title : ""
    const hasDistinctTitle = rawTitle.length > 0 && rawTitle !== sessionId
    if (format === "html") {
        const titlePart = hasDistinctTitle ? ` (<i>${esc(rawTitle)}</i>)` : ""
        return `/chat_${sessionId}${titlePart}\n\n`
    }
    const titlePart = hasDistinctTitle ? ` (${rawTitle})` : ""
    return `/chat_${sessionId}${titlePart}\n\n`
}

function replyError(conn, requestId, text) {
    return {
        stateChanges: {},
        effects: [
            {
                type: "ipc_respond",
                conn,
                message: {
                    type: "tool_response",
                    requestId,
                    result: {
                        content: [{ type: "text", text }],
                        isError: true,
                    },
                },
            },
        ],
    }
}

function replyOk(conn, requestId, text) {
    return [
        {
            type: "ipc_respond",
            conn,
            message: {
                type: "tool_response",
                requestId,
                result: {
                    content: [{ type: "text", text }],
                },
            },
        },
    ]
}
