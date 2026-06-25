/**
 * dtach outbound side effects.
 *
 * Injects text into a worker Claude Code session by piping to
 * `dtach -p <socket>`. The socket path is looked up from
 * core.chatSessions[sessionId].dtachSocket.
 */

import { readFileSync } from "node:fs"
import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { typeIntoDtach } = await versionedImport("../dtach-inject.js", import.meta)
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

// Pause between the text write and the Enter write. Gives Ink's input
// loop time to process the text chunk and render the frame before the
// Enter arrives. If both writes land in the same read() on claude's
// side, Ink's paste heuristic coalesces them and the \r becomes a
// literal newline in the prompt buffer instead of a submit.
const SUBMIT_DELAY_MS = 120

// 0x0d (\r / Carriage Return) is the byte a terminal emulator sends
// when the user presses Return in raw mode. Ink treats it as the
// submit trigger — provided it arrives on its own, not as the tail
// of a larger paste.
const ENTER_KEYSTROKE = new Uint8Array([0x0d])

/**
 * Push a raw byte sequence into an existing dtach session by spawning
 * `dtach -p <sock>` and writing to its stdin. dtach forwards those
 * bytes straight to the pty master, so from claude's perspective they
 * are indistinguishable from keystrokes typed at an attached terminal.
 */
async function pushToDtach(dtachSocket, bytes) {
    const proc = new Deno.Command("dtach", {
        args: ["-p", dtachSocket],
        stdin: "piped",
        stdout: "null",
        stderr: "null",
    }).spawn()
    const w = proc.stdin.getWriter()
    await w.write(bytes)
    await w.close()
    await proc.status
}

export async function sendTextToClaude(effect, core) {
    const { sessionId, text } = effect
    const session = core.chatSessions?.[sessionId]
    const dtachSocket = session?.dtachSocket
    if (!dtachSocket) {
        dbg("DTACH-OUT", `no dtach socket for session ${sessionId}`)
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
        dbg("DTACH-OUT", `disconnect detect failed for ${sessionId}:`, e)
    }

    try {
        // Step 1: write the text bytes alone. From Ink's side this
        // looks like pasted content arriving in the prompt buffer.
        await pushToDtach(dtachSocket, new TextEncoder().encode(text))
        // Step 2: brief pause so Ink can finish its render cycle.
        await new Promise((resolve) => setTimeout(resolve, SUBMIT_DELAY_MS))
        // Step 3: send Enter as its own write so Ink sees it as a
        // distinct keypress event, not a paste trailer.
        await pushToDtach(dtachSocket, ENTER_KEYSTROKE)
        dbg("DTACH-OUT", `injected text+Enter to ${sessionId} (${text.length} chars)`)
    } catch (e) {
        dbg("DTACH-OUT", `inject failed for ${sessionId}:`, e)
    }

    if (stateChanges) {
        return { stateChanges }
    }
}

/**
 * Inject raw text into a session's dtach socket character-by-character
 * with a slight pause between each, then a trailing carriage return.
 * Unlike sendTextToClaude, this streams the bytes straight through as if
 * typed, which is what you want when feeding input to whatever program is
 * currently attached (a shell, a REPL, a prompt, etc.), not just Claude's
 * TUI. The actual injection lives in lib/dtach-inject.js (shared with the
 * `cbg self-input` CLI).
 *
 * effect shape: { type: "send_raw_input_to_claude", sessionId, text }
 */
export async function sendRawInputToClaude(effect, core) {
    const { sessionId, text } = effect
    const session = core.chatSessions?.[sessionId]
    const dtachSocket = session?.dtachSocket
    if (!dtachSocket) {
        dbg("DTACH-OUT", `sendRawInputToClaude: no dtach socket for session ${sessionId}`)
        return
    }
    if (typeof text !== "string") {
        dbg("DTACH-OUT", `sendRawInputToClaude: text is not a string for session ${sessionId}`)
        return
    }
    try {
        await typeIntoDtach(dtachSocket, text)
        dbg("DTACH-OUT", `injected raw input to ${sessionId} (${text.length} chars)`)
    } catch (e) {
        dbg("DTACH-OUT", `sendRawInputToClaude inject failed for ${sessionId}:`, e)
    }
}

/**
 * Hand a list of file paths to a worker Claude Code session by injecting
 * one `[file: <path>]` line per path through dtach. Claude can then read
 * each path with its Read tool.
 *
 * dtach is a text injection channel, not a file transfer protocol — this
 * is the simplest real implementation we can ship until we have a richer
 * sideband. Failures are logged but not thrown.
 *
 * effect shape: { type: "send_files_to_claude", sessionId, filePaths: [...] }
 */
export async function sendFilesToClaude(effect, core) {
    const { sessionId, filePaths } = effect
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
        dbg("DTACH-OUT", `sendFilesToClaude: no filePaths for session ${sessionId}`)
        return
    }
    const session = core.chatSessions?.[sessionId]
    const dtachSocket = session?.dtachSocket
    if (!dtachSocket) {
        dbg("DTACH-OUT", `sendFilesToClaude: no dtach socket for session ${sessionId}`)
        return
    }
    for (const path of filePaths) {
        if (typeof path !== "string" || path.length === 0) {
            dbg("DTACH-OUT", `sendFilesToClaude: skipping invalid path entry: ${path}`)
            continue
        }
        try {
            const proc = new Deno.Command("dtach", {
                args: ["-p", dtachSocket],
                stdin: "piped",
                stdout: "null",
                stderr: "null",
            }).spawn()
            const w = proc.stdin.getWriter()
            await w.write(new TextEncoder().encode(`[file: ${path}]\n`))
            await w.close()
            await proc.status
            dbg("DTACH-OUT", `injected file marker for ${sessionId}: ${path}`)
        } catch (e) {
            dbg("DTACH-OUT", `sendFilesToClaude inject failed for ${sessionId} (${path}):`, e)
        }
    }
}
