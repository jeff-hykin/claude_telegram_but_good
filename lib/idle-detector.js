import { dbg } from "./protocol.js"

export function createIdleDetector() {
    const handlers = new Map()
    const lastStopAt = new Map()

    async function runHandlers(sessionId, source) {
        for (const [name, fn] of handlers) {
            try {
                await fn(sessionId, source)
            } catch (e) {
                dbg("IDLE", `handler "${name}" threw for session ${sessionId} (${source}):`, e)
            }
        }
    }

    return {
        onSessionStop(sessionId) {
            lastStopAt.set(sessionId, Date.now())
            return runHandlers(sessionId, "stop")
        },

        onSessionIdle(sessionId) {
            return runHandlers(sessionId, "idle-fallback")
        },

        addHandler(name, fn) {
            handlers.set(name, fn)
        },

        removeHandler(name) {
            handlers.delete(name)
        },

        getLastStopAt(sessionId) {
            return lastStopAt.get(sessionId) ?? null
        },

        clearSession(sessionId) {
            lastStopAt.delete(sessionId)
        },
    }
}
