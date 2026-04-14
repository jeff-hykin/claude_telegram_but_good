/**
 * dtach outbound side effects.
 *
 * Injects text into a worker Claude Code session by piping to
 * `dtach -p <socket>`. The socket path is looked up from
 * core.chatSessions[sessionId].dtachSocket.
 */

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)

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
