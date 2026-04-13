/**
 * Deliver a channel_event notification to a worker session's shim via IPC.
 *
 * effect shape: { type: "deliver_channel_event", sessionId, content, meta }
 *
 * The shim receives this over its long-lived IPC conn and converts it
 * into an MCP channel/message notification so Claude sees it as user input.
 */

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { encodeIpcFrame } = await versionedImport("../ipc.js", import.meta)

export async function deliverChannelEvent(effect, core) {
    const { sessionId, content, meta } = effect
    const session = core.chatSessions?.[sessionId]
    if (!session?._conn) {
        dbg("CHANNEL-EVENT", `no _conn for session ${sessionId}`)
        return
    }
    // Awaiting here (rather than fire-and-forget) means an async write
    // failure is caught by the outer try/catch instead of becoming an
    // unhandled rejection. The `delivered` log only fires on success.
    try {
        await session._conn.write(encodeIpcFrame({ type: "channel_event", content, meta }))
        dbg("CHANNEL-EVENT", `delivered to ${sessionId} (${String(content).length} chars)`)
    } catch (e) {
        dbg("CHANNEL-EVENT", `delivery failed for ${sessionId}:`, e)
    }
}
