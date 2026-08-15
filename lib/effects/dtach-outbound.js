/**
 * Agent-session outbound side effects.
 *
 * Pushes text, raw keystrokes and file handoffs into a worker session.
 * How that lands is the backend's business: the Claude backend types into
 * a dtach-wrapped pty, the local backend writes an IPC frame. This module
 * only resolves the session and dispatches (lib/agent-backends/).
 *
 * The disconnect scan below stays here rather than moving into the Claude
 * backend because it is about the USER's experience of a silent session,
 * and it already no-ops for any session without a dtach log.
 */

import { readFileSync } from "node:fs"
import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { backendForSession } = await versionedImport("../agent-backends/index.js", import.meta)
const { scanForDisconnect } = await versionedImport("../pure/disconnect-scan.js", import.meta)
const { replyToForSession, sendEffect } = await versionedImport("../pure/reply-to.js", import.meta)
const { sendTextMessageToUser } = await versionedImport("./telegram-outbound.js", import.meta)

/**
 * When we inject a follow-up message (nudge, check-in, etc.) into a
 * session, scan its rendered screen for Claude Code's API-reconnect
 * banner ("Retrying in 0s · attempt 7/10"). If found, notify the user so
 * a silent disconnection doesn't look like the agent has simply gone
 * quiet. De-duplicated per attempt number via session.lastDisconnectAttempt
 * so one episode produces at most one message per attempt change; cleared
 * once a later follow-up sees no banner (episode resolved).
 *
 * Returns a stateChanges patch to apply, or null if nothing changed.
 */
async function detectDisconnect(sessionId, session, core) {
    const dtachSocket = session?.dtachSocket
    if (!dtachSocket) {
        return null
    }
    const logPath = dtachSocket.replace(/\.sock$/, ".log")

    let content
    try {
        content = readFileSync(logPath, "utf8")
    } catch (e) {
        dbg("DISCONNECT", `read ${logPath} failed for ${sessionId}:`, e)
        return null
    }

    let hit
    try {
        hit = scanForDisconnect(content)
    } catch (e) {
        dbg("DISCONNECT", `scan failed for ${sessionId}:`, e)
        return null
    }

    const lastNotified = session.lastDisconnectAttempt ?? null

    if (!hit) {
        // No banner on screen. If we'd flagged an episode, clear it so a
        // future disconnection notifies again.
        if (lastNotified != null) {
            return { chatSessions: { [sessionId]: { lastDisconnectAttempt: undefined } } }
        }
        return null
    }

    // Banner present. Skip if we already told the user about this exact
    // attempt number (avoids duplicate identical messages).
    if (hit.attempt === lastNotified) {
        return null
    }

    const replyTo = replyToForSession(sessionId, core, "disconnect-detect")
    if (!replyTo.chatId) {
        dbg("DISCONNECT", `no destination chat for ${sessionId} — recording but not sending`)
        return { chatSessions: { [sessionId]: { lastDisconnectAttempt: hit.attempt } } }
    }

    dbg("DISCONNECT", `notifying ${replyTo.chatId} of ${sessionId} disconnect attempt ${hit.attempt}/${hit.max}`)
    try {
        await sendTextMessageToUser(
            sendEffect(replyTo, `Claude disconnection detected (attempt ${hit.attempt} of ${hit.max})`),
            core,
        )
    } catch (e) {
        dbg("DISCONNECT", `notify send failed for ${sessionId}:`, e)
    }
    return { chatSessions: { [sessionId]: { lastDisconnectAttempt: hit.attempt } } }
}

/**
 * effect shape: { type: "send_text_to_claude", sessionId, text, kind }
 *
 * The generic "say this to the agent" path: nudges, check-ins, queue
 * drains, injected prompts.
 */
export async function sendTextToClaude(effect, core) {
    const { sessionId, text, kind } = effect
    const session = core.chatSessions?.[sessionId]
    if (!session) {
        dbg("AGENT-OUT", `no session ${sessionId}`)
        return
    }

    // Before injecting this follow-up, check whether the session's screen
    // shows Claude's API-reconnect banner — a disconnection that would
    // otherwise look like the agent merely going quiet. Notify the user if
    // so. Done first so we read the screen that triggered the nudge.
    let stateChanges = null
    try {
        stateChanges = await detectDisconnect(sessionId, session, core)
    } catch (e) {
        dbg("AGENT-OUT", `disconnect detect failed for ${sessionId}:`, e)
    }

    const result = await backendForSession(session).sendUserText({ session, text, kind })
    if (!result.ok) {
        dbg("AGENT-OUT", `sendUserText failed for ${sessionId}: ${result.detail}`)
    }

    if (stateChanges) {
        return { stateChanges }
    }
}

/**
 * Feed raw keystrokes to whatever program the session is attached to (a
 * shell, a REPL, an arrow-key menu) rather than sending a user turn.
 * Backends without a terminal report this unsupported.
 *
 * effect shape: { type: "send_raw_input_to_claude", sessionId, text, submit, atomic }
 */
export async function sendRawInputToClaude(effect, core) {
    const { sessionId, text, submit = true, atomic = false } = effect
    const session = core.chatSessions?.[sessionId]
    if (!session) {
        dbg("AGENT-OUT", `sendRawInputToClaude: no session ${sessionId}`)
        return
    }
    if (typeof text !== "string") {
        dbg("AGENT-OUT", `sendRawInputToClaude: text is not a string for session ${sessionId}`)
        return
    }
    const result = await backendForSession(session).sendRawInput({ session, text, submit, atomic })
    if (!result.ok) {
        dbg("AGENT-OUT", `sendRawInput failed for ${sessionId}: ${result.detail}`)
    }
}

/**
 * Hand a list of file paths to a worker session so the agent can read them.
 *
 * effect shape: { type: "send_files_to_claude", sessionId, filePaths: [...] }
 */
export async function sendFilesToClaude(effect, core) {
    const { sessionId, filePaths } = effect
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
        dbg("AGENT-OUT", `sendFilesToClaude: no filePaths for session ${sessionId}`)
        return
    }
    const session = core.chatSessions?.[sessionId]
    if (!session) {
        dbg("AGENT-OUT", `sendFilesToClaude: no session ${sessionId}`)
        return
    }
    const result = await backendForSession(session).sendFiles({ session, filePaths })
    if (!result.ok) {
        dbg("AGENT-OUT", `sendFiles failed for ${sessionId}: ${result.detail}`)
    }
}
