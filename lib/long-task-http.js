/**
 * HTTP endpoint for the long-task subsystem.
 *
 * Starts a local HTTP server that worker sessions use to submit
 * definitions-of-done and query task status.
 */

import { join } from "../imports.js"
import { STATE_DIR, dbg } from "./protocol.js"
import { getConfig } from "./config.js"
import { readTask, updateTask, storeDefinition, getDefinition, taskPath } from "./long-task.js"

const PORT_FILE = join(STATE_DIR, "long-task-http.port")
const DEFAULT_PORT = 19541

let server = null

/**
 * Try to start Deno.serve on the given port.
 * Returns the Deno.HttpServer instance, or null if the port is busy.
 */
async function tryListen(port) {
    try {
        const srv = Deno.serve(
            { hostname: "127.0.0.1", port, onListen: () => {} },
            handleRequest,
        )
        return srv
    } catch (e) {
        if (e instanceof Deno.errors.AddrInUse) {
            return null
        }
        throw e
    }
}

/**
 * Route incoming requests.
 */
async function handleRequest(req) {
    const url = new URL(req.url)
    const path = url.pathname

    // POST /long-tasks/<id>/definition
    const defMatch = path.match(/^\/long-tasks\/([^/]+)\/definition$/)
    if (defMatch && req.method === "POST") {
        return await handleDefinition(defMatch[1], req)
    }

    // GET /long-tasks/<id>/status
    const statusMatch = path.match(/^\/long-tasks\/([^/]+)\/status$/)
    if (statusMatch && req.method === "GET") {
        return await handleStatus(statusMatch[1])
    }

    return new Response("Not found", { status: 404 })
}

/**
 * POST /long-tasks/<id>/definition
 */
async function handleDefinition(taskId, req) {
    try {
        const task = readTask(taskId)
        if (!task) {
            return new Response("Task not found", { status: 400 })
        }
        if (task.state !== "defining") {
            return new Response(`Task is in state "${task.state}", expected "defining"`, { status: 400 })
        }
        const existing = getDefinition(taskId)
        if (existing) {
            return new Response("Definition already submitted", { status: 409 })
        }

        const body = await req.text()
        storeDefinition(taskId, body)
        updateTask(taskId, { state: "in_progress" })

        return new Response("Definition received. Begin work.", { status: 200 })
    } catch (e) {
        dbg("LONG-TASK-HTTP", "definition endpoint error:", e)
        return new Response("Internal error", { status: 500 })
    }
}

/**
 * GET /long-tasks/<id>/status
 */
async function handleStatus(taskId) {
    try {
        const task = readTask(taskId)
        if (!task) {
            return new Response("Task not found", { status: 404 })
        }

        const dir = taskPath(taskId)
        const fileExists = (name) => {
            try {
                Deno.statSync(join(dir, name))
                return true
            } catch {
                return false
            }
        }

        const payload = {
            id: taskId,
            state: task.state,
            hasReport: fileExists("report.md"),
            hasRevisions: fileExists("revisions.md"),
            hasContext: fileExists("context.md"),
        }

        return new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" },
        })
    } catch (e) {
        dbg("LONG-TASK-HTTP", "status endpoint error:", e)
        return new Response("Internal error", { status: 500 })
    }
}

/**
 * Start the HTTP server. Tries the configured port, then port+1 as fallback.
 * Returns the port number on success, or null on failure.
 */
export async function startHttpServer() {
    if (server) {
        dbg("LONG-TASK-HTTP", "server already running, skipping start")
        return getHttpPort()
    }

    const configuredPort = Number(getConfig("longTask.httpPort")) || DEFAULT_PORT

    server = await tryListen(configuredPort)
    let actualPort = configuredPort

    if (!server) {
        dbg("LONG-TASK-HTTP", `port ${configuredPort} busy, trying ${configuredPort + 1}`)
        server = await tryListen(configuredPort + 1)
        actualPort = configuredPort + 1
    }

    if (!server) {
        dbg("LONG-TASK-HTTP", `failed to bind on ports ${configuredPort} and ${configuredPort + 1}`)
        return null
    }

    try {
        Deno.mkdirSync(STATE_DIR, { recursive: true })
        Deno.writeTextFileSync(PORT_FILE, String(actualPort))
    } catch (e) {
        dbg("LONG-TASK-HTTP", "failed to write port file:", e)
    }

    dbg("LONG-TASK-HTTP", `listening on 127.0.0.1:${actualPort}`)
    return actualPort
}

/**
 * Read the port from the state file (for embedding in prompts).
 * Returns the port number, or null if the file doesn't exist.
 */
export function getHttpPort() {
    try {
        const raw = Deno.readTextFileSync(PORT_FILE).trim()
        const port = Number(raw)
        if (Number.isFinite(port) && port > 0) {
            return port
        }
        return null
    } catch (e) {
        dbg("LONG-TASK-HTTP", "could not read port file:", e)
        return null
    }
}

/**
 * Gracefully shut down the HTTP server and clean up the port file.
 */
export async function stopHttpServer() {
    if (!server) {
        return
    }
    try {
        await server.shutdown()
        dbg("LONG-TASK-HTTP", "server shut down")
    } catch (e) {
        dbg("LONG-TASK-HTTP", "error during shutdown:", e)
    }
    server = null

    try {
        Deno.removeSync(PORT_FILE)
    } catch (e) {
        dbg("LONG-TASK-HTTP", "could not remove port file:", e)
    }
}
