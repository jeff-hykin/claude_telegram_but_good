import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { paths } = await versionedImport("../paths.js", import.meta)
const { resolveTarget: resolveTargetPrefixed, parseTargetAddress } = await versionedImport("../pure/target-resolver.js", import.meta)
const { generateName } = await versionedImport("../pure/ids.js", import.meta)

// "Busy" means a Stop hook is expected to fire — i.e. the agent is mid-turn.
// Used for `cbg tell --que` / `cbg ask --que`: if the session is idle, no
// upcoming Stop will drain the queue, so we deliver immediately instead.
//
// Two signals combined (the `status` field alone is unreliable: chat-user.js
// updates it on Telegram inbound but tell_session/ask_sync don't, so back-to-
// back CLI tells would race the status update and look spuriously idle):
//   1. status !== "idle" — covers Telegram-driven turns + sessions still in
//      their post-register kickoff phase ("working").
//   2. lastActive > lastStopAt — covers CLI-driven turns: pre/post-tool hooks
//      bump lastActive while the agent runs tools, and only Stop bumps
//      lastStopAt. Tool activity newer than the last Stop ⇒ mid-turn.
function isSessionBusy(session) {
    if (!session) { return false }
    if ((session.status ?? "idle") !== "idle") { return true }
    const lastActive = session.lastActive ?? 0
    const lastStopAt = session.lastStopAt ?? 0
    return lastActive > lastStopAt
}

export default function handle(event, core) {
    const kind = event.kind
    const payload = event.payload ?? {}
    const conn = event._conn

    if (kind === "set_pending_otp") {
        const otp = payload.otp
        if (!otp) {
            return respond(conn, { ok: false, error: "missing otp" })
        }
        dbg("CLI-CMD", `set_pending_otp: stored otp=${otp}`)
        return {
            stateChanges: {
                chatState: {
                    pendingOtps: {
                        [otp]: { createdAt: event.ts, chatId: null },
                    },
                },
            },
            effects: [
                {
                    type: "ipc_respond",
                    conn,
                    message: { ok: true },
                    closeAfter: true,
                },
            ],
        }
    }

    if (kind === "reload_cbg") {
        // Compute the new version WITHOUT mutating globalThis — tooling
        // will apply the bump. The reply embeds the projected new version.
        const currentVersion = globalThis.cbgVersion ?? 1
        const newVersion = currentVersion + 1
        dbg("CLI-CMD", `reload_cbg: projecting version ${currentVersion} -> ${newVersion}`)
        return {
            stateChanges: {},
            effects: [
                { type: "bump_cbg_version", toVersion: newVersion },
                {
                    type: "ipc_respond",
                    conn,
                    message: { ok: true, version: newVersion },
                    closeAfter: true,
                },
            ],
        }
    }

    if (kind === "get_cbg_version") {
        const version = globalThis.cbgVersion ?? 1
        return respond(conn, { ok: true, version })
    }

    if (kind === "server_dump") {
        const dumpPath = payload.targetPath ?? paths.makeDumpPath()
        const snapshot = {
            timestamp: new Date().toISOString(),
            cbgVersion: globalThis.cbgVersion ?? 1,
            chatState: stripPrivate(core.chatState),
            chatSessions: stripPrivate(core.chatSessions),
            specialData: stripPrivate(core.specialData),
        }
        dbg("CLI-CMD", `server_dump: emitting write_file for ${dumpPath}`)
        return {
            stateChanges: {},
            effects: [
                { type: "write_file", path: dumpPath, content: JSON.stringify(snapshot, null, 2) },
                {
                    type: "ipc_respond",
                    conn,
                    message: { ok: true, dumpPath },
                    closeAfter: true,
                },
            ],
        }
    }

    if (kind === "list_sessions") {
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
        result.sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))
        return respond(conn, { ok: true, sessions: result })
    }

    if (kind === "tell_session") {
        const { target, text, replyToInbox, queueUntilIdle } = payload
        if (!target) { return respond(conn, { ok: false, error: "missing target" }) }
        if (!text) { return respond(conn, { ok: false, error: "missing text" }) }

        const resolved = resolveTargetPrefixed(target, core)
        if (resolved.inbox) {
            return respond(conn, { ok: false, error: `cbg tell does not route to inboxes — use \`cbg ask\` or write directly to ${resolved.inbox}/messages.jsonl` })
        }
        if (resolved.error) {
            return respond(conn, { ok: false, error: resolved.error })
        }

        const cc = core.chatState?.commandCenter ?? {}
        const targetSession = resolved.session
        const targetId = targetSession.id
        const toThreadId = cc.topicMap?.[targetId] ?? null
        const toTopic = toThreadId ? (cc.topicNames?.[toThreadId] ?? null) : "_unbound"

        // Build the message content with reply hint
        const fromLabel = replyToInbox ? `inbox:${replyToInbox}` : "CLI"
        const replyHint = replyToInbox
            ? ` — reply with: tell_session target="${replyToInbox}" text="..."`
            : ""
        const content = `[from ${fromLabel}${replyHint}]\n${text}`

        const logEntry = {
            ts: new Date().toISOString(),
            from: replyToInbox ? { cli: true, inboxId: replyToInbox } : { cli: true },
            to: { sessionId: targetId, topicName: toTopic },
            text,
            source: "cli",
        }

        // --que: queue for next Stop instead of delivering now, UNLESS the
        // session is already idle — in that case there's no upcoming Stop
        // to drain on, so deliver immediately.
        if (queueUntilIdle && isSessionBusy(targetSession)) {
            const existingQueue = targetSession.pendingQueue ?? []
            const queueEntry = {
                text: content,
                chatId: "cbg-internal",
                messageId: `cli-que-${Date.now()}`,
                threadId: null,
                queuedAt: Date.now(),
                _source: "cli",  // suppresses the Telegram drain-notification in claude-hook-stop
            }
            return {
                stateChanges: {
                    chatSessions: {
                        [targetId]: { pendingQueue: [...existingQueue, queueEntry] },
                    },
                },
                effects: [
                    {
                        type: "ipc_respond",
                        conn,
                        message: { ok: true, message: `queued for ${targetId} (${existingQueue.length + 1} pending; will deliver after current turn)` },
                        closeAfter: true,
                    },
                    {
                        type: "log_inter_session_message",
                        entry: { ...logEntry, queued: true },
                        topicNames: [toTopic],
                    },
                ],
            }
        }

        return {
            // Bump lastActive so a follow-up `cbg tell --que` sent
            // immediately afterward correctly identifies this session
            // as busy (no hook event has fired yet at this point).
            stateChanges: {
                chatSessions: { [targetId]: { lastActive: Date.now() } },
            },
            effects: [
                {
                    type: "ipc_respond",
                    conn,
                    message: { ok: true, message: `delivered to ${targetId} (resolved from "${target}")` },
                    closeAfter: true,
                },
                {
                    type: "deliver_channel_event",
                    sessionId: targetId,
                    content,
                    meta: { source: "cli_tell", fromCli: true, fromInbox: replyToInbox ?? null },
                },
                {
                    type: "log_inter_session_message",
                    entry: logEntry,
                    topicNames: [toTopic],
                },
            ],
        }
    }

    if (kind === "ask_sync") {
        const { target, text, replyToInbox, queueUntilIdle } = payload
        if (!target) { return respond(conn, { ok: false, error: "missing target" }) }
        if (!text) { return respond(conn, { ok: false, error: "missing text" }) }
        if (!replyToInbox) { return respond(conn, { ok: false, error: "missing replyToInbox" }) }

        const resolved = resolveTargetPrefixed(target, core)
        if (resolved.inbox) {
            return respond(conn, { ok: false, error: "ask_sync requires a live session target, not an inbox address" })
        }
        if (resolved.error) {
            return respond(conn, { ok: false, error: resolved.error })
        }

        const cc = core.chatState?.commandCenter ?? {}
        const targetSession = resolved.session
        const targetId = targetSession.id
        const toThreadId = cc.topicMap?.[targetId] ?? null
        const toTopic = toThreadId ? (cc.topicNames?.[toThreadId] ?? null) : "_unbound"

        const content = `[from inbox:${replyToInbox} — reply with: tell_session target="${replyToInbox}" text="..."]\n${text}`

        const baseEffects = [
            { type: "register_inbox_waiter", address: replyToInbox, conn, targetSessionId: targetId },
            {
                type: "log_inter_session_message",
                entry: {
                    ts: new Date().toISOString(),
                    from: { cli: true, inboxId: replyToInbox },
                    to: { sessionId: targetId, topicName: toTopic },
                    text,
                    source: "cli_ask_sync",
                    queued: !!(queueUntilIdle && isSessionBusy(targetSession)),
                },
                topicNames: [toTopic],
            },
        ]

        // --que: hold the question in the session's pendingQueue so it
        // delivers on next Stop. The inbox waiter is already registered,
        // so the eventual reply still wakes up this CLI conn. If the
        // session is already idle, queueing would never drain — fall
        // through to immediate delivery.
        if (queueUntilIdle && isSessionBusy(targetSession)) {
            const existingQueue = targetSession.pendingQueue ?? []
            const queueEntry = {
                text: content,
                chatId: "cbg-internal",
                messageId: `cli-ask-${Date.now()}`,
                threadId: null,
                queuedAt: Date.now(),
                _source: "cli",
            }
            return {
                stateChanges: {
                    chatSessions: {
                        [targetId]: { pendingQueue: [...existingQueue, queueEntry] },
                    },
                },
                effects: baseEffects,
            }
        }

        // NOTE: no immediate ipc_respond — the conn stays open until the
        // reply (routed via notify_inbox_waiter) or the daemon/CLI dies.
        return {
            // Bump lastActive so a concurrent `cbg tell --que` sees this
            // session as busy (no hook event has fired yet for this turn).
            stateChanges: {
                chatSessions: { [targetId]: { lastActive: Date.now() } },
            },
            effects: [
                ...baseEffects,
                {
                    type: "deliver_channel_event",
                    sessionId: targetId,
                    content,
                    meta: { source: "cli_tell", fromCli: true, fromInbox: replyToInbox },
                },
            ],
        }
    }

    if (kind === "touch_session") {
        return handleTouchSession(payload, conn, core)
    }

    if (kind === "shutdown") {
        dbg("CLI-CMD", "shutdown: reply sent, shell will handle actual shutdown")
        return respond(conn, { ok: true })
    }

    dbg("CLI-CMD", `unknown kind: ${kind}`)
    return respond(conn, { ok: false, error: "unknown kind" })
}

/**
 * `cbg new --touch <prefixed-target>` — ensure a session exists at the
 * given address. Returns the resolved info immediately.
 *
 *   topic:<name>   — return the live session bound to that topic, or
 *                    spawn one (refresh-style) if none exists. Errors
 *                    if the topic name isn't known to the daemon.
 *   session:<id>   — return the live session with that ID, or spawn a
 *                    brand-new session (auto-named, no topic). The id
 *                    hint is discarded on creation.
 *   title:<sub>    — return the unique live session whose title contains
 *                    the substring, or spawn a new session with that
 *                    string as its title. Errors on ambiguity.
 *   inbox:<addr>   — error: inboxes aren't sessions.
 *   <bare>/cbg:    — error: --touch requires an explicit prefix so the
 *                    caller can't accidentally create the wrong thing.
 */
function handleTouchSession(payload, conn, core) {
    const { target } = payload
    if (!target) { return respond(conn, { ok: false, error: "missing target" }) }

    const parsed = parseTargetAddress(target)
    const sessions = core.chatSessions ?? {}
    const cc = core.chatState?.commandCenter ?? {}

    if (parsed.mode === "inbox") {
        return respond(conn, { ok: false, error: "touch does not apply to inboxes — inboxes have no session" })
    }
    if (parsed.mode === "auto") {
        return respond(conn, { ok: false, error: "touch requires an explicit prefix: session:<id>, topic:<name>, or title:<sub>" })
    }
    if (!parsed.value) {
        return respond(conn, { ok: false, error: `${parsed.mode}: address is empty` })
    }

    if (parsed.mode === "session") {
        const existing = sessions[parsed.value]
        if (existing?._conn) {
            return respondInfo(conn, sessionInfo(existing, cc, false))
        }
        return spawnAndRespond(conn, { title: undefined, topicName: null, threadId: null, cc, core })
    }

    if (parsed.mode === "topic") {
        const wantedName = parsed.value
        let threadId = findThreadIdByTopicName(cc, wantedName)
        if (!threadId) {
            // No Telegram thread bound to this name yet — synthesize a
            // local-only threadId so the binding is recorded and future
            // touches are idempotent. The "synth:" prefix keeps it
            // visually distinct and ensures it can never collide with
            // a real numeric Telegram thread id.
            threadId = `synth:${wantedName.toLowerCase()}`
        }
        const existingId = cc.threadMap?.[threadId]
        const existing = existingId ? sessions[existingId] : null
        if (existing?._conn) {
            return respondInfo(conn, sessionInfo(existing, cc, false))
        }
        const canonicalName = cc.topicNames?.[threadId] ?? wantedName
        return spawnAndRespond(conn, { title: canonicalName, topicName: canonicalName, threadId, cc, core })
    }

    if (parsed.mode === "title") {
        const matches = []
        const needle = parsed.value.toLowerCase()
        for (const s of Object.values(sessions)) {
            if (!s?._conn) { continue }
            if (s.title && s.title.toLowerCase().includes(needle)) {
                matches.push(s)
            }
        }
        if (matches.length === 1) {
            return respondInfo(conn, sessionInfo(matches[0], cc, false))
        }
        if (matches.length > 1) {
            const ids = matches.map(s => `${s.id} (${s.title})`).join(", ")
            return respond(conn, { ok: false, error: `ambiguous: ${matches.length} sessions match title "${parsed.value}" (${ids}). Use session:<ID>.` })
        }
        return spawnAndRespond(conn, { title: parsed.value, topicName: null, threadId: null, cc, core })
    }

    return respond(conn, { ok: false, error: `unsupported touch mode: ${parsed.mode}` })
}

function findThreadIdByTopicName(cc, name) {
    const topicNames = cc.topicNames ?? {}
    const lower = name.toLowerCase()
    for (const [threadId, n] of Object.entries(topicNames)) {
        if (typeof n === "string" && n.toLowerCase() === lower) { return threadId }
    }
    return null
}

function sessionInfo(s, cc, created) {
    const threadId = cc.topicMap?.[s.id] ?? null
    const topicName = threadId ? (cc.topicNames?.[threadId] ?? null) : null
    return {
        sessionId: s.id,
        title: s.title ?? null,
        topicName,
        threadId,
        dtachSocket: s.dtachSocket ?? paths.dtachSockFile(s.id),
        pid: s.pid ?? null,
        connected: !!s._conn,
        created,
    }
}

function spawnAndRespond(conn, { title, topicName, threadId, cc, core }) {
    const sessionId = generateName()
    const dtachSocket = paths.dtachSockFile(sessionId)

    // Queue an initial "kickoff" message targeted at this new session
    // so it gets a channel notification immediately on register, the
    // same way /refresh does. Empirically, fresh sessions that receive
    // their FIRST channel notification at register-time survive; sessions
    // that sit idle and then receive a notification later get SIGTERM'd
    // by Claude Code (see QualifiedBandicoot incident).
    const queueEntry = {
        content: `You were just spawned via \`cbg new --touch ${topicName ? `topic:${topicName}` : title ? `title:${title}` : `session:${sessionId}`}\`. ${topicName ? `You're bound to topic "${topicName}".` : ""} Stand by — another session/CLI may message you shortly via the channel.`,
        meta: { source: "touch_kickoff", chat_id: "cbg-internal", message_id: `kickoff-${Date.now()}` },
        targetSessionId: sessionId,
        queuedAt: Date.now(),
    }
    const existingQueue = core?.chatState?.messageQueue ?? []

    const stateChanges = {
        chatState: {
            messageQueue: [...existingQueue, queueEntry],
            pendingFocusId: sessionId,
        },
    }
    if (threadId) {
        const topicMap = { ...(cc.topicMap ?? {}) }
        const threadMap = { ...(cc.threadMap ?? {}) }
        const topicNames = { ...(cc.topicNames ?? {}) }
        const oldId = threadMap[threadId]
        if (oldId) { delete topicMap[oldId] }
        topicMap[sessionId] = String(threadId)
        threadMap[String(threadId)] = sessionId
        if (topicName) { topicNames[String(threadId)] = topicName }
        stateChanges.chatState.commandCenter = { ...cc, topicMap, threadMap, topicNames }
    }

    const info = {
        sessionId,
        title: title ?? null,
        topicName: topicName ?? null,
        threadId: threadId ? String(threadId) : null,
        dtachSocket,
        pid: null,
        connected: false,
        created: true,
    }

    return {
        stateChanges,
        effects: [
            { type: "spawn_dtach_session", sessionId, title, topicName },
            {
                type: "ipc_respond",
                conn,
                message: { ok: true, info },
                closeAfter: true,
            },
        ],
    }
}

function respondInfo(conn, info) {
    return respond(conn, { ok: true, info })
}

function respond(conn, message) {
    return {
        stateChanges: {},
        effects: [
            {
                type: "ipc_respond",
                conn,
                message,
                closeAfter: true,
            },
        ],
    }
}

function stripPrivate(value) {
    if (value === null || value === undefined) {
        return value
    }
    if (Array.isArray(value)) {
        return value.map((item) => stripPrivate(item))
    }
    if (typeof value === "object") {
        const out = {}
        for (const key in value) {
            if (key.startsWith("_")) {
                continue
            }
            out[key] = stripPrivate(value[key])
        }
        return out
    }
    if (typeof value === "function") {
        return undefined
    }
    return value
}
