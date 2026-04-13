/**
 * Cold storage — append-only JSONL archives for long-term history.
 *
 * Unlike the transient hot state held in memory by the standalone server,
 * cold storage persists across restarts and is the source of truth for
 * rebuilding things like per-chat message history or long-task timelines.
 *
 * Three streams live under $STATE_DIR/cold-storage/:
 *   - messages.jsonl   — Telegram messages (from: "user" | "agent")
 *   - long-tasks.jsonl — long-task state transitions
 *   - hooks.jsonl      — optional hook event archive
 */

import { versionedImport } from "./version.js"

const [
    { paths },
    { dbg },
] = await Promise.all([
    versionedImport("./paths.js", import.meta),
    versionedImport("./logging.js", import.meta),
])

// Re-exported under the legacy name used by tests/cold-storage-test.js.
export const COLD_DIR = paths.COLD_STORAGE_DIR

const VALID_STREAMS = new Set(["messages", "long-tasks", "hooks"])

function streamPath(stream) {
    if (!VALID_STREAMS.has(stream)) {
        throw new Error(`cold-storage: invalid stream name "${stream}" (valid: ${[...VALID_STREAMS].join(", ")})`)
    }
    return paths.coldStorageStreamFile(stream)
}

function ensureColdDir() {
    try {
        Deno.mkdirSync(COLD_DIR, { recursive: true })
    } catch (e) {
        if (!(e instanceof Deno.errors.AlreadyExists)) {
            dbg("COLD", "failed to create cold-storage dir:", e)
            throw e
        }
    }
}

/**
 * Append a JSONL entry to a cold-storage stream.
 * The entry is stamped with `ts: Date.now()` if it doesn't already have one.
 */
export function appendColdEntry(stream, entry) {
    const path = streamPath(stream)
    ensureColdDir()
    const stamped = (entry && entry.ts != null) ? entry : { ts: Date.now(), ...entry }
    try {
        Deno.writeTextFileSync(path, JSON.stringify(stamped) + "\n", { append: true })
    } catch (e) {
        dbg("COLD", `failed to append to ${stream}:`, e)
        throw e
    }
}

export function appendColdMessage(entry) {
    appendColdEntry("messages", entry)
}

export function appendColdLongTaskEvent(entry) {
    appendColdEntry("long-tasks", entry)
}

export function appendColdHookEvent(entry) {
    appendColdEntry("hooks", entry)
}

/**
 * Read an entire cold-storage stream and return all parsed entries.
 * Newest entries are at the end. Returns [] if the file doesn't exist.
 * Malformed lines are logged via dbg() and skipped.
 */
export function readColdStream(stream) {
    const path = streamPath(stream)
    let text
    try {
        text = Deno.readTextFileSync(path)
    } catch (e) {
        if (e instanceof Deno.errors.NotFound) {
            return []
        }
        dbg("COLD", `failed to read ${stream}:`, e)
        return []
    }
    const out = []
    const lines = text.split("\n")
    for (const line of lines) {
        if (line.length === 0) {
            continue
        }
        try {
            out.push(JSON.parse(line))
        } catch (e) {
            dbg("COLD", `skipping malformed line in ${stream}:`, e, "line:", line)
        }
    }
    return out
}

/**
 * Return the last N entries from a stream (newest last).
 * For v1, we read the whole file and slice — fine for expected volumes.
 */
export function tailColdStream(stream, n) {
    const all = readColdStream(stream)
    if (n == null || n < 0) {
        return all
    }
    if (all.length <= n) {
        return all
    }
    return all.slice(all.length - n)
}

/**
 * Return the last N messages for a specific chatId.
 * Used on startup to rebuild specialData.telegramMessagesByChatId.
 */
export function tailMessagesByChatId(chatId, n) {
    const all = readColdStream("messages")
    const filtered = []
    for (const entry of all) {
        if (entry && entry.chatId != null && String(entry.chatId) === String(chatId)) {
            filtered.push(entry)
        }
    }
    if (n == null || n < 0) {
        return filtered
    }
    if (filtered.length <= n) {
        return filtered
    }
    return filtered.slice(filtered.length - n)
}

/**
 * Return every long-task event for a given taskId, in insertion order.
 * Used by /task_history queries.
 */
export function findLongTaskHistory(taskId) {
    const all = readColdStream("long-tasks")
    const out = []
    for (const entry of all) {
        if (entry && entry.taskId != null && String(entry.taskId) === String(taskId)) {
            out.push(entry)
        }
    }
    return out
}
