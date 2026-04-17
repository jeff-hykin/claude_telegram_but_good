// ---------------------------------------------------------------------------
// session_register handler.
//
// Emitted by the IPC translator when a shim sends { type: "register", ... }.
// Adds the new session to `chatSessions`, decides whether it should become
// focused (pending-focus promotion or auto-focus if nothing is focused yet),
// and replies to the shim over its unix-socket conn with the current session
// list so it knows the handshake completed.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { findDtachPidStrict } = await versionedImport("../pid.js", import.meta)
const { loadAccess } = await versionedImport("../access.js", import.meta)

function deriveTitle(session) {
    if (!session) { return "session" }
    const cwd = session.cwd ?? ""
    const base = cwd.split("/").filter(Boolean).pop() ?? "session"
    const branch = session.gitBranch ? ` (${session.gitBranch})` : ""
    return `${base}${branch}`
}

export default function handle(event, core) {
    const session = event.session
    if (!session || typeof session.id !== "string") {
        dbg("SESSION-REG", "invalid event, missing session.id")
        return null
    }

    const id = session.id
    const chatState = core.chatState ?? {}

    // Check dtach ancestry. The shim reports its own claude pid; we walk
    // upward looking for a `dtach` process. If none is found the session
    // will never be reachable by /peek, /cancel, /pause, /resume — we
    // record this on the session entry and emit a follow-up warning.
    let inDtach = false
    try {
        if (typeof session.pid === "number" && session.pid > 0) {
            inDtach = findDtachPidStrict(session.pid) != null
        }
    } catch (e) {
        dbg("SESSION-REG", "findDtachPidStrict threw:", e)
    }

    // Build the new session entry. Include non-serializable _conn — the
    // persistence layer strips underscore-prefixed keys before writing.
    //
    // `activeSpinner: undefined` explicitly clears any spinner carried
    // forward from a previous registration of the same session id
    // (mergeSessionData's undefined-sentinel → delete rule). Without
    // this, a shim that reconnects after a transient disconnect would
    // inherit a stale messageId and the first hook would try to edit
    // a dead Telegram message.
    //
    // `lastActive` is preserved across reconnects: registration itself
    // is not activity, so a shim coming back after a daemon restart
    // should keep its prior timestamp. Real activity is recorded by the
    // pre/post-tool-use + stop hook handlers. Only initialize to event.ts
    // when we have never seen this session id before (first-time start).
    const priorLastActive = core.chatSessions?.[id]?.lastActive
    // If the session has no explicit title, check if it's bound to a
    // command center topic and use the topic name. Fall back to deriving
    // from cwd + branch so /list always shows something useful.
    const cc = core.chatState?.commandCenter ?? {}
    const topicThreadId = cc.topicMap?.[id]
    const topicName = topicThreadId ? cc.topicNames?.[topicThreadId] : null
    const effectiveTitle = session.title ?? topicName ?? deriveTitle(session)
    const newSessionEntry = {
        ...session,
        title: effectiveTitle,
        _conn: event._conn,
        lastActive: priorLastActive ?? event.ts,
        lastStopAt: null,
        recentMessages: [],
        activeSpinner: undefined,
        inDtach,
    }

    // Decide focus transition.
    let focusedId = chatState.focusedSessionId ?? null
    const chatStatePatch = {}

    if (chatState.pendingFocusId === id) {
        dbg("SESSION-REG", `promoting pendingFocusId -> focused: ${id}`)
        chatStatePatch.focusedSessionId = id
        chatStatePatch.pendingFocusId = undefined
        focusedId = id
    } else if (focusedId === null || focusedId === undefined) {
        dbg("SESSION-REG", `auto-focusing first session: ${id}`)
        chatStatePatch.focusedSessionId = id
        focusedId = id
    } else {
        dbg("SESSION-REG", `registered ${id}, focus stays on ${focusedId}`)
    }

    // Build the reply payload — serializable summaries of every session
    // (existing + the new one we're adding in this same action).
    const existingSessions = core.chatSessions ?? {}
    const allEntries = { ...existingSessions, [id]: newSessionEntry }
    const sessionsSummary = []
    for (const [sid, s] of Object.entries(allEntries)) {
        if (!s) { continue }
        sessionsSummary.push({
            id: s.id ?? sid,
            pid: s.pid ?? null,
            cwd: s.cwd ?? null,
            title: s.title ?? null,
            gitBranch: s.gitBranch ?? null,
            connectedAt: s.connectedAt ?? null,
        })
    }

    const stateChanges = {
        chatSessions: { [id]: newSessionEntry },
    }
    if (Object.keys(chatStatePatch).length > 0) {
        stateChanges.chatState = chatStatePatch
    }

    const effects = [
        {
            type: "ipc_respond",
            conn: event._conn,
            message: {
                type: "registered",
                sessions: sessionsSummary,
                focusedId,
            },
        },
    ]

    // Drain queued inbound messages onto the newly-focused session.
    // Only fire when this register call actually CAUSED the focus change
    // (either pendingFocusId promotion or first-session auto-focus). If
    // focus stays on a different session, the queue keeps waiting.
    const becameFocused = focusedId === id && chatStatePatch.focusedSessionId === id
    if (becameFocused) {
        const queue = core.chatState?.messageQueue ?? []
        if (queue.length > 0) {
            dbg("SESSION-REG", `draining ${queue.length} queued message(s) to ${id}`)
            for (const entry of queue) {
                effects.push({
                    type: "deliver_channel_event",
                    sessionId: id,
                    content: entry.content,
                    meta: entry.meta,
                })
            }
            // Clear the queue. mergeSessionData replaces arrays wholesale,
            // so an empty array on the patch wipes the stored queue.
            stateChanges.chatState = { ...(stateChanges.chatState ?? {}), messageQueue: [] }
        }
    }

    const followUpEvents = []
    if (!inDtach) {
        dbg("SESSION-REG", `session ${id} has no dtach ancestor — queuing warning`)
        followUpEvents.push({
            type: "session_register_no_dtach",
            sessionId: id,
            cwd: session.cwd ?? null,
            gitBranch: session.gitBranch ?? null,
            pid: session.pid ?? null,
        })
    }

    // Command center: if a command center is active, auto-bind to an
    // existing topic (by title match) or create a new topic. If the
    // session has no explicit title, derive one from cwd + git branch
    // so that every session gets a topic.
    const access = loadAccess()
    const ccChatId = access.commandCenterChatId
    // cc already declared above for topic name lookup
    const sessionTitle = session.title ?? topicName ?? deriveTitle(session)

    if (ccChatId && sessionTitle && !cc.topicMap?.[id]) {
        // Check if this session is already in the reverse map (reconnect)
        let foundThread = null
        for (const [threadKey, sid] of Object.entries(cc.threadMap ?? {})) {
            if (sid === id) {
                foundThread = threadKey
                break
            }
        }
        if (foundThread) {
            dbg("SESSION-REG", `re-binding session ${id} to existing topic ${foundThread}`)
            const topicMap = { ...(cc.topicMap ?? {}), [id]: foundThread }
            stateChanges.chatState = {
                ...(stateChanges.chatState ?? {}),
                commandCenter: { ...cc, topicMap },
            }
        } else {
            // Create a new topic for this session. The create_thread
            // effect returns a state patch that updates topicMap/threadMap.
            dbg("SESSION-REG", `creating topic for session ${id} ("${sessionTitle}")`)
            effects.push({
                type: "create_thread",
                chatId: ccChatId,
                title: sessionTitle,
                sessionId: id,
            })
        }
    }

    return {
        stateChanges,
        effects,
        followUpEvents,
    }
}
