// ---------------------------------------------------------------------------
// event-generators/agent-runner/daemon-link.js — the runner's half of the
// session-side wire protocol (lib/agent-backends/spec.js, HALF B).
//
// This is to the local agent what the MCP shim + hook script together are
// to Claude Code: one long-lived IPC connection that registers the
// session, emits the turn-lifecycle hook_event frames, round-trips
// tool_request calls, and receives inbound user text.
//
// Everything downstream in the daemon (spinner, nudge watchdog, long
// tasks, the critic, scheduled tasks) keys off these frames and nothing
// else, which is why a backend with no TUI still gets all of it.
// ---------------------------------------------------------------------------

import { paths } from "../../lib/paths.js"
import { dbg } from "../../lib/logging.js"
import { writeIpcFrame, parseIpcMessages } from "../../lib/ipc.js"

const RECONNECT_INITIAL_MS = 2_000
const RECONNECT_MAX_MS = 30_000

export class DaemonLink {
    /**
     * @param {object} sessionInfo — the `register` payload; must carry
     *     id, pid and backend.
     * @param {(msg: object) => void} onMessage — daemon→session frames
     *     that aren't tool_response (channel_event, agent_input, ...).
     */
    constructor(sessionInfo, onMessage) {
        this.sessionInfo = sessionInfo
        this.onMessage = onMessage
        this.conn = null
        this.readBuffer = ""
        this.pending = new Map()  // requestId → {resolve}
        this.reconnectDelayMs = RECONNECT_INITIAL_MS
        this.shuttingDown = false
        this.nextRequestId = 0
    }

    async connect() {
        try {
            this.conn = await Deno.connect({ transport: "unix", path: paths.IPC_SOCK })
        } catch (e) {
            dbg("RUNNER-IPC", "connect failed:", e)
            this.scheduleReconnect()
            return
        }
        this.reconnectDelayMs = RECONNECT_INITIAL_MS
        this.send({ type: "register", session: this.sessionInfo })
        this.readLoop()
    }

    async readLoop() {
        const decoder = new TextDecoder()
        const buf = new Uint8Array(8192)
        while (true) {
            let n
            try {
                n = await this.conn.read(buf)
            } catch (e) {
                dbg("RUNNER-IPC", "read error:", e)
                break
            }
            if (n == null) { break }
            const { messages, remaining } = parseIpcMessages(this.readBuffer, decoder.decode(buf.subarray(0, n)))
            this.readBuffer = remaining
            for (const msg of messages) {
                if (msg.type === "tool_response") {
                    const waiter = this.pending.get(msg.requestId)
                    if (waiter) {
                        this.pending.delete(msg.requestId)
                        waiter.resolve(msg.result)
                    } else {
                        dbg("RUNNER-IPC", "tool_response for unknown requestId:", msg.requestId)
                    }
                    continue
                }
                try {
                    this.onMessage(msg)
                } catch (e) {
                    dbg("RUNNER-IPC", "onMessage threw:", e)
                }
            }
        }
        this.conn = null
        this.readBuffer = ""
        this.scheduleReconnect()
    }

    scheduleReconnect() {
        if (this.shuttingDown) { return }
        const delay = this.reconnectDelayMs
        this.reconnectDelayMs = Math.min(delay * 2, RECONNECT_MAX_MS)
        dbg("RUNNER-IPC", `reconnect in ${delay}ms`)
        setTimeout(() => {
            if (this.shuttingDown) { return }
            this.connect().catch((e) => {
                dbg("RUNNER-IPC", "reconnect threw:", e)
                this.scheduleReconnect()
            })
        }, delay)
    }

    send(msg) {
        if (!this.conn) {
            dbg("RUNNER-IPC", `dropping ${msg.type} — not connected`)
            return
        }
        writeIpcFrame(this.conn, msg).catch((e) => dbg("RUNNER-IPC", "write failed:", e))
    }

    /**
     * Call one of the daemon's channel tools (reply, react, set_title,
     * list_sessions, ...) and wait for its tool_response. Resolves to
     * null if the daemon never answers within `timeoutMs`, so a wedged
     * daemon stalls one tool call rather than the whole agent loop.
     */
    callTool(name, args, timeoutMs = 30_000) {
        const requestId = `lr${Deno.pid}-${this.nextRequestId++}`
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId)
                dbg("RUNNER-IPC", `tool ${name} timed out after ${timeoutMs}ms`)
                resolve(null)
            }, timeoutMs)
            this.pending.set(requestId, {
                resolve: (result) => {
                    clearTimeout(timer)
                    resolve(result)
                },
            })
            this.send({ type: "tool_request", requestId, sessionId: this.sessionInfo.id, name, args })
        })
    }

    /** Turn-lifecycle frame. See spec.js — this is the load-bearing one. */
    hook(hookEventName, extra = {}) {
        this.send({
            type: "hook_event",
            claudePid: this.sessionInfo.pid,
            data: { hook_event_name: hookEventName, session_id: this.sessionInfo.id, ...extra },
        })
    }

    shutdown(reason = "exit") {
        this.shuttingDown = true
        this.send({ type: "unregister", sessionId: this.sessionInfo.id, reason })
        try {
            this.conn?.close()
        } catch (e) {
            dbg("RUNNER-IPC", "close failed:", e)
        }
    }
}
