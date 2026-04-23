// ---------------------------------------------------------------------------
// lib/event-handlers/tui-snapshot.js
//
// Periodic screen-buffer snapshotter. For each session in
// `status: "working" | "frozen"` (i.e. one that has an in-flight
// request the stall detector is watching), reads `tail -c N` of its
// dtach log, hashes it, and appends `{ hash, ts }` to a ring buffer
// on `chatSessions[sid].screenBufferRecord`. Used by stall-check.js
// to decide whether a worker has wedged.
//
// Idle sessions are skipped: no stall_check is ever reading their
// ring, so appending to it is pure overhead (disk read + state patch
// + persistence schedule per tick per idle session). A session that
// has never entered a waiting state has no `status` field at all —
// it's treated as idle and skipped.
//
// The handler re-schedules itself via a `set_timer` effect, forming a
// continuous loop that runs for the lifetime of the daemon. The initial
// tick is scheduled once from `main-server.js` at startup.
//
// The ring is capped at (stall_detected_ms * 2) / screen_snapshot_interval_ms
// entries — enough history to cover the full stall window twice over with
// headroom for the edge cases. At defaults (60s stall / 20s interval), that
// is 6 entries spanning 2 minutes.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const {
    getScreenSnapshotIntervalMs,
    getScreenSnapshotTailBytes,
    getStallDetectedMs,
} = await versionedImport("../config-manager.js", import.meta)
const { detectPrompts, stripAnsi } = await versionedImport("../pure/tui-prompt-detector.js", import.meta)

/**
 * Read the last `tailBytes` bytes of a file and return them as a string.
 * Returns `null` on any error (file missing, permission denied, etc).
 * Does NOT log errors — a stale dtach log missing from disk is routine
 * for sessions that have unregistered but whose state is still loaded.
 */
function readTail(path, tailBytes) {
    try {
        const f = Deno.openSync(path, { read: true })
        try {
            const stat = f.statSync()
            const size = Number(stat.size)
            if (size === 0) {
                return ""
            }
            const start = Math.max(0, size - tailBytes)
            f.seekSync(start, Deno.SeekMode.Start)
            const buf = new Uint8Array(Math.min(size, tailBytes))
            const n = f.readSync(buf)
            if (n === null) {
                return ""
            }
            return new TextDecoder("utf-8", { fatal: false }).decode(buf.subarray(0, n))
        } finally {
            f.close()
        }
    } catch (e) {
        dbg("SCREEN-SNAP", "readTail failed for", path, ":", e)
        return null
    }
}

/**
 * FNV-1a 32-bit hash of a string, returned as 8-char hex. Not
 * cryptographic; just a cheap fingerprint for "did these bytes change?".
 */
function shortHash(s) {
    let h = 0x811c9dc5
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i)
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
    }
    return h.toString(16).padStart(8, "0")
}

/**
 * Event shape (synthetic — no external source):
 *   { type: "screen_snapshot_tick", ts }
 *
 * The handler iterates every session and patches its screenBufferRecord,
 * then emits a single `set_timer` to schedule the next tick.
 */
export default function handle(event, core) {
    const sessions = core.chatSessions ?? {}
    const now = event.ts ?? Date.now()

    const tailBytes = getScreenSnapshotTailBytes()
    const intervalMs = getScreenSnapshotIntervalMs()
    const stallMs = getStallDetectedMs()

    // Ring size: enough snapshots to cover two full stall windows.
    // At defaults (60s / 20s): 6 entries spanning 2 minutes.
    const ringSize = Math.max(3, Math.ceil((stallMs * 2) / intervalMs))

    const sessionPatches = {}
    const followUpEvents = []

    for (const [sid, session] of Object.entries(sessions)) {
        if (!session) {
            continue
        }
        const isInFlight = session.status === "working" || session.status === "frozen"
        const logPath = session.dtachSocket
            ? session.dtachSocket.replace(/\.sock$/, ".log")
            : null
        if (!logPath) {
            continue
        }
        const tail = readTail(logPath, tailBytes)
        if (tail === null) {
            // File missing or unreadable; skip (don't corrupt the ring).
            continue
        }
        const hash = shortHash(tail)

        // Only update the screen buffer ring for in-flight sessions
        // (working/frozen). Idle sessions don't need stall detection.
        if (isInFlight) {
            const prevRecord = Array.isArray(session.screenBufferRecord)
                ? session.screenBufferRecord
                : []
            const nextRecord = [...prevRecord, { hash, ts: now }]
            while (nextRecord.length > ringSize) {
                nextRecord.shift()
            }
            sessionPatches[sid] = { screenBufferRecord: nextRecord }
        }

        // Prompt detection: scan for blocking TUI prompts on every
        // tick for all sessions with content. We read a larger tail
        // (16KB) than the stall-detection hash (300B) because prompt
        // text gets pushed out of the small window by spinner output.
        // Deduplication in tui-prompt-detected.js (_lastPromptHandled)
        // prevents re-answering the same prompt.
        const promptTail = tailBytes < 16384 ? readTail(logPath, 16384) : tail
        if (promptTail && promptTail.length > 0) {
            try {
                const stripped = stripAnsi(promptTail)
                const prompts = detectPrompts(stripped)
                for (const prompt of prompts) {
                    followUpEvents.push({
                        type: "tui_prompt_detected",
                        sessionId: sid,
                        prompt,
                        ts: now,
                    })
                }
            } catch (e) {
                dbg("TUI-SNAP", `prompt detection failed for ${sid}:`, e)
            }
        }
    }

    const stateChanges = Object.keys(sessionPatches).length > 0
        ? { chatSessions: sessionPatches }
        : {}

    // Always reschedule — the loop runs for the daemon's lifetime.
    return {
        stateChanges,
        effects: [
            {
                type: "set_timer",
                delayMs: intervalMs,
                event: { type: "screen_snapshot_tick" },
            },
        ],
        followUpEvents,
    }
}
