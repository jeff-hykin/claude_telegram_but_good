// ---------------------------------------------------------------------------
// lib/session-liveness.js
//
// Whether a session id can still come back. A registered session is gone once
// its pid is; an unregistered one (still starting) is gone once its dtach
// socket is. Queue entries aimed at a gone session can never be delivered.
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs"
import { versionedImport } from "./version.js"

const { isPidAlive } = await versionedImport("./pid.js", import.meta)
const { paths } = await versionedImport("./paths.js", import.meta)

/** True when `sessionId` is neither running nor starting. */
export function isSessionGone(core, sessionId) {
    const session = core.chatSessions?.[sessionId]
    if (session) {
        return typeof session.pid === "number" && !isPidAlive(session.pid)
    }
    return !existsSync(paths.dtachSockFile(sessionId))
}

/** The message queue minus entries targeted at sessions that are gone. */
export function withoutGoneTargets(core, messageQueue) {
    return messageQueue.filter(entry => !entry.targetSessionId || !isSessionGone(core, entry.targetSessionId))
}
