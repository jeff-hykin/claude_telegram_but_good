import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { paths } = await versionedImport("../paths.js", import.meta)

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
        const { target, text, replyToInbox } = payload
        if (!target) { return respond(conn, { ok: false, error: "missing target" }) }
        if (!text) { return respond(conn, { ok: false, error: "missing text" }) }

        // reuse resolveTarget from claude-channel (inline here since handlers are pure)
        const sessions = core.chatSessions ?? {}
        const cc = core.chatState?.commandCenter ?? {}

        const resolved = resolveTellTarget(target, sessions, cc)
        if (resolved.error) {
            return respond(conn, { ok: false, error: resolved.error })
        }

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

        return {
            stateChanges: {},
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

    if (kind === "shutdown") {
        dbg("CLI-CMD", "shutdown: reply sent, shell will handle actual shutdown")
        return respond(conn, { ok: true })
    }

    dbg("CLI-CMD", `unknown kind: ${kind}`)
    return respond(conn, { ok: false, error: "unknown kind" })
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

/**
 * Resolve a flexible address to a connected session.
 * Tries: exact session ID → topic name → title substring.
 */
function resolveTellTarget(address, sessions, cc) {
    // 1) exact session ID
    if (sessions[address]?._conn) {
        return { session: sessions[address] }
    }

    // 2) topic name
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

    // 3) title substring
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
