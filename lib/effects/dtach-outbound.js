/**
 * dtach outbound side effects.
 *
 * Injects text into a worker Claude Code session by piping to
 * `dtach -p <socket>`. The socket path is looked up from
 * core.chatSessions[sessionId].dtachSocket.
 */

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)

export async function sendTextToClaude(effect, core) {
    const { sessionId, text } = effect
    const session = core.chatSessions?.[sessionId]
    const dtachSocket = session?.dtachSocket
    if (!dtachSocket) {
        dbg("DTACH-OUT", `no dtach socket for session ${sessionId}`)
        return
    }
    try {
        const proc = new Deno.Command("dtach", {
            args: ["-p", dtachSocket],
            stdin: "piped",
            stdout: "null",
            stderr: "null",
        }).spawn()
        const w = proc.stdin.getWriter()
        // Send both \r and \n: \r is what Claude's raw-mode TUI binds to
        // "submit" (the terminal's Enter key), while \n alone is Ctrl+J and
        // only inserts a literal newline into the prompt buffer — which left
        // earlier nudges visibly accumulating in the input area without ever
        // being submitted as a turn.
        await w.write(new TextEncoder().encode(text + "\r\n"))
        await w.close()
        await proc.status
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
