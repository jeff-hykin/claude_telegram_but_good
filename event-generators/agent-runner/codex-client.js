// ---------------------------------------------------------------------------
// event-generators/agent-runner/codex-client.js — a client for the stdio
// JSON-RPC protocol spoken by `codex app-server`.
//
// Transport only. It knows nothing about cbg: it spawns the app-server,
// correlates requests with responses, and hands notifications and
// server→client requests to callbacks. codex-runner.js is what maps those
// onto cbg's session-side protocol.
//
// Wire format, confirmed against codex-cli 0.149.1:
//   - bare newline-delimited JSON, NOT LSP Content-Length framing
//   - responses come back as {id, result} or {id, error}; the app-server
//     omits the "jsonrpc" field on the way out even though it accepts it
//   - notifications are {method, params, emittedAtMs} with no id
//   - server→client REQUESTS are {id, method, params} — an id AND a
//     method. That combination is the only way to tell them apart from a
//     response, and forgetting to answer one wedges the turn forever,
//     because Codex is blocking on it.
//   - the server numbers ITS requests from 0 in its own id space, so our
//     request ids are strings — nothing then has to reason about whether
//     an id 0 is ours or theirs.
// ---------------------------------------------------------------------------

import { dbg } from "../../lib/logging.js"

export class CodexAppServer {
    /**
     * @param {object} options
     * @param {string} options.binary — the codex executable
     * @param {string} options.cwd — working directory for the app-server
     * @param {(method: string, params: object) => void} options.onNotification
     * @param {(id: any, method: string, params: object) => void} options.onServerRequest
     * @param {(line: string) => void} [options.onStderr]
     * @param {() => void} [options.onExit]
     */
    constructor(options) {
        this.options = options
        this.child = null
        this.writer = null
        this.pending = new Map()  // request id → {resolve, reject, timer}
        this.nextId = 1
        this.closed = false
    }

    async start() {
        this.child = new Deno.Command(this.options.binary, {
            args: ["app-server"],
            cwd: this.options.cwd,
            env: this.options.env ?? {},
            stdin: "piped",
            stdout: "piped",
            stderr: "piped",
        }).spawn()
        this.writer = this.child.stdin.getWriter()
        this.readLoop()
        this.stderrLoop()
        this.child.status.then((status) => {
            this.closed = true
            dbg("CODEX-RPC", `app-server exited: code=${status.code} signal=${status.signal}`)
            for (const [id, waiter] of this.pending) {
                clearTimeout(waiter.timer)
                waiter.reject(new Error(`app-server exited before answering request ${id}`))
            }
            this.pending.clear()
            this.options.onExit?.()
        })
    }

    async readLoop() {
        const decoder = new TextDecoder()
        let buffer = ""
        try {
            for await (const chunk of this.child.stdout) {
                buffer += decoder.decode(chunk, { stream: true })
                let newline = buffer.indexOf("\n")
                while (newline !== -1) {
                    const line = buffer.slice(0, newline).trim()
                    buffer = buffer.slice(newline + 1)
                    if (line) {
                        this.dispatch(line)
                    }
                    newline = buffer.indexOf("\n")
                }
            }
        } catch (e) {
            dbg("CODEX-RPC", "stdout read failed:", e)
        }
    }

    async stderrLoop() {
        const decoder = new TextDecoder()
        try {
            for await (const chunk of this.child.stderr) {
                for (const line of decoder.decode(chunk).split("\n")) {
                    if (line.trim()) {
                        this.options.onStderr?.(line.trim())
                    }
                }
            }
        } catch (e) {
            dbg("CODEX-RPC", "stderr read failed:", e)
        }
    }

    dispatch(line) {
        let msg
        try {
            msg = JSON.parse(line)
        } catch (e) {
            dbg("CODEX-RPC", `unparseable line (${line.slice(0, 200)}):`, e)
            return
        }
        if (msg.id !== undefined && msg.method) {
            try {
                this.options.onServerRequest(msg.id, msg.method, msg.params ?? {})
            } catch (e) {
                dbg("CODEX-RPC", `onServerRequest threw for ${msg.method}:`, e)
            }
            return
        }
        if (msg.id !== undefined) {
            const waiter = this.pending.get(msg.id)
            if (!waiter) {
                dbg("CODEX-RPC", "response for unknown id:", msg.id)
                return
            }
            this.pending.delete(msg.id)
            clearTimeout(waiter.timer)
            if (msg.error) {
                waiter.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)))
            } else {
                waiter.resolve(msg.result)
            }
            return
        }
        if (msg.method) {
            try {
                this.options.onNotification(msg.method, msg.params ?? {})
            } catch (e) {
                dbg("CODEX-RPC", `onNotification threw for ${msg.method}:`, e)
            }
        }
    }

    async writeLine(payload) {
        if (this.closed) {
            throw new Error("app-server is not running")
        }
        await this.writer.write(new TextEncoder().encode(`${JSON.stringify(payload)}\n`))
    }

    /** Send a request and wait for its response. */
    request(method, params = {}, timeoutMs = 120_000) {
        const id = `cbg-${this.nextId++}`
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id)
                reject(new Error(`codex ${method} timed out after ${timeoutMs}ms`))
            }, timeoutMs)
            this.pending.set(id, { resolve, reject, timer })
            this.writeLine({ jsonrpc: "2.0", id, method, params }).catch((e) => {
                this.pending.delete(id)
                clearTimeout(timer)
                reject(e)
            })
        })
    }

    notify(method, params = {}) {
        this.writeLine({ jsonrpc: "2.0", method, params })
            .catch((e) => dbg("CODEX-RPC", `notify ${method} failed:`, e))
    }

    /** Answer a server→client request. Codex blocks until this arrives. */
    respond(id, result) {
        this.writeLine({ jsonrpc: "2.0", id, result })
            .catch((e) => dbg("CODEX-RPC", `respond to ${id} failed:`, e))
    }

    close() {
        this.closed = true
        try {
            this.writer?.close()
        } catch (e) {
            dbg("CODEX-RPC", "stdin close failed:", e)
        }
        try {
            this.child?.kill("SIGTERM")
        } catch (e) {
            dbg("CODEX-RPC", "kill failed:", e)
        }
    }
}
