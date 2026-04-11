/**
 * Per-session message tracker.
 *
 * Records the most recent inbound (Telegram -> session) and outbound
 * (session -> Telegram) messages for each session, persisted to
 * STATE_DIR/message_tracker.json. The watchdog reads this to detect
 * sessions that received a user message but never replied, so it can
 * nudge Claude to actually send something back.
 *
 * State shape:
 *   {
 *     [sessionId]: {
 *       lastInbound: { messageId, chatId, ts, text } | null,
 *       lastOutbound: { ts, text } | null,
 *       nudged: boolean
 *     }
 *   }
 *
 * `nudged` is reset every time a new inbound is recorded — one nudge
 * per pending message, max.
 */

import { join } from "../imports.js"
import { STATE_DIR, dbg } from "./protocol.js"

const TRACKER_FILE = join(STATE_DIR, "message_tracker.json")

let state = load()

function load() {
    try {
        const raw = Deno.readTextFileSync(TRACKER_FILE)
        return JSON.parse(raw)
    } catch (e) {
        dbg("TRACKER", "no existing tracker file (fresh start):", e?.message ?? e)
        return {}
    }
}

function save() {
    try {
        Deno.writeTextFileSync(TRACKER_FILE, JSON.stringify(state, null, 2))
    } catch (e) {
        dbg("TRACKER", "save failed:", e)
    }
}

function ensure(sessionId) {
    if (!state[sessionId]) {
        state[sessionId] = { lastInbound: null, lastOutbound: null, nudged: false }
    }
    return state[sessionId]
}

export function recordInbound(sessionId, { messageId, chatId, text }) {
    if (!sessionId) {
        return
    }
    const entry = ensure(sessionId)
    entry.lastInbound = {
        messageId: messageId != null ? String(messageId) : null,
        chatId: chatId != null ? String(chatId) : null,
        ts: Date.now(),
        text: typeof text === "string" ? text.slice(0, 500) : "",
    }
    entry.nudged = false
    save()
}

export function recordOutbound(sessionId, { text } = {}) {
    if (!sessionId) {
        return
    }
    const entry = ensure(sessionId)
    entry.lastOutbound = {
        ts: Date.now(),
        text: typeof text === "string" ? text.slice(0, 500) : "",
    }
    save()
}

export function isPending(sessionId) {
    const entry = state[sessionId]
    if (!entry || !entry.lastInbound) {
        return false
    }
    if (!entry.lastOutbound) {
        return true
    }
    return entry.lastOutbound.ts < entry.lastInbound.ts
}

export function getEntry(sessionId) {
    return state[sessionId] ?? null
}

export function getAll() {
    return { ...state }
}

export function markNudged(sessionId) {
    const entry = state[sessionId]
    if (!entry) {
        return
    }
    entry.nudged = true
    save()
}

export function dropSession(sessionId) {
    if (state[sessionId]) {
        delete state[sessionId]
        save()
    }
}
