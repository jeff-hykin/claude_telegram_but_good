import { versionedImport } from "../version.js"
import { readFileSync } from "node:fs"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { paths } = await versionedImport("../paths.js", import.meta)
const { makeReplyTo } = await versionedImport("../pure/reply-to.js", import.meta)

/**
 * When a filter string is provided, extract matching log lines from
 * main.log. Matches against session IDs, thread IDs, titles, PIDs,
 * and topic names. Returns the last 200 matching lines.
 */
function extractFilteredLog(filter) {
    if (!filter) { return null }
    const needle = filter.toLowerCase()
    try {
        const raw = readFileSync(paths.LOG_FILE, "utf8")
        const lines = raw.split("\n")
        const matched = []
        for (const line of lines) {
            if (line.toLowerCase().includes(needle)) {
                matched.push(line)
            }
        }
        // Return last 200 matching lines to keep output manageable
        return matched.slice(-200)
    } catch (e) {
        dbg("SERVER-DUMP", "extractFilteredLog failed:", e)
        return null
    }
}

/**
 * Filter the snapshot to only include sessions/topics matching the
 * filter string. Matches against session ID, title, PID, thread ID,
 * and topic name.
 */
function filterSnapshot(snapshot, filter) {
    if (!filter) { return snapshot }
    const needle = filter.toLowerCase()
    const filtered = { ...snapshot }

    // Filter chatSessions
    if (filtered.chatSessions) {
        const filteredSessions = {}
        for (const [sid, sess] of Object.entries(filtered.chatSessions)) {
            const matches =
                sid.toLowerCase().includes(needle) ||
                (sess.title ?? "").toLowerCase().includes(needle) ||
                String(sess.pid ?? "").includes(needle)
            if (matches) {
                filteredSessions[sid] = sess
            }
        }
        filtered.chatSessions = filteredSessions
    }

    // Add topic info summary when command center is active
    if (filtered.chatState?.commandCenter) {
        const cc = filtered.chatState.commandCenter
        const topicSummary = {}
        const topicNames = cc.topicNames ?? {}
        const threadMap = cc.threadMap ?? {}
        const topicMap = cc.topicMap ?? {}

        for (const [threadId, sessionId] of Object.entries(threadMap)) {
            const name = topicNames[threadId] ?? "(unnamed)"
            const matchesTopic =
                name.toLowerCase().includes(needle) ||
                threadId.includes(needle) ||
                sessionId.toLowerCase().includes(needle)
            if (matchesTopic || !filter) {
                topicSummary[threadId] = {
                    topicName: name,
                    sessionId,
                    sessionExists: !!filtered.chatSessions?.[sessionId],
                }
            }
        }
        filtered._topicSummary = topicSummary
    }

    return filtered
}

export default function handle(event, core) {
    const dumpPath = event.targetPath ?? paths.makeDumpPath()
    const filter = event.filter ?? null
    let snapshot = {
        timestamp: new Date().toISOString(),
        cbgVersion: globalThis.cbgVersion ?? 1,
        chatState: stripPrivate(core.chatState),
        chatSessions: stripPrivate(core.chatSessions),
        specialData: stripPrivate(core.specialData),
    }

    // Apply filter if provided
    snapshot = filterSnapshot(snapshot, filter)

    // Extract matching log lines when filtered
    const filteredLog = extractFilteredLog(filter)
    if (filteredLog) {
        snapshot._filteredLogLines = filteredLog.length
        snapshot._filteredLog = filteredLog
    }

    const dumpContent = JSON.stringify(snapshot, null, 2)
    dbg("SERVER-DUMP", `emitting write_file + reply (source=${event.source}${filter ? `, filter="${filter}"` : ""})`)

    const writeEffect = { type: "write_file", path: dumpPath, content: dumpContent }

    if (event.source === "telegram") {
        return {
            stateChanges: {},
            effects: [
                writeEffect,
                {
                    type: "send_file_to_user",
                    replyTo: makeReplyTo({ chatId: event.chatId, threadId: null, setBy: "server-dump:telegram" }),
                    filePath: dumpPath,
                    filename: "cbg-dump.json",
                },
            ],
        }
    }

    if (event.source === "mcp_tool") {
        return {
            stateChanges: {},
            effects: [
                writeEffect,
                {
                    type: "ipc_respond",
                    conn: event._conn,
                    message: {
                        type: "tool_response",
                        requestId: event.requestId,
                        result: {
                            content: [
                                {
                                    type: "text",
                                    text: JSON.stringify({ logPath: paths.LOG_FILE, dumpPath }),
                                },
                            ],
                        },
                    },
                },
            ],
        }
    }

    dbg("SERVER-DUMP", `unknown source: ${event.source}`)
    return { stateChanges: {}, effects: [writeEffect] }
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
