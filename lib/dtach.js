/**
 * dtach session helpers: install check, create, attach, list.
 *
 * paths is loaded via versionedImport so this module shares the single
 * versioned `paths` singleton with the rest of the reloadable graph
 * (see lib/logging.js's header for the full rationale).
 */

import { versionedImport } from "./version.js"
import { generateName } from "./pure/ids.js"

const { paths } = await versionedImport("./paths.js", import.meta)

function exec(cmd, args) {
    try {
        const result = new Deno.Command(cmd, {
            args,
            stdout: "piped",
            stderr: "piped",
        }).outputSync()
        return {
            success: result.success,
            stdout: new TextDecoder().decode(result.stdout).trim(),
            stderr: new TextDecoder().decode(result.stderr).trim(),
        }
    } catch {
        return { success: false, stdout: "", stderr: "command not found" }
    }
}

export function isDtachInstalled() {
    return exec("which", ["dtach"]).success
}

/**
 * Try to install dtach using available package managers.
 * Returns true if dtach is now available.
 */
export function ensureDtach() {
    if (isDtachInstalled()) {
        return true
    }

    if (exec("which", ["nix"]).success) {
        console.log("Installing dtach via nix...")
        const r = exec("nix", ["profile", "install", "nixpkgs#dtach"])
        if (r.success && isDtachInstalled()) {
            return true
        }
    }

    if (Deno.build.os === "linux" && exec("which", ["apt-get"]).success) {
        console.log("Installing dtach via apt-get...")
        const r = exec("sudo", ["apt-get", "install", "-y", "dtach"])
        if (r.success && isDtachInstalled()) {
            return true
        }
    }

    if (exec("which", ["brew"]).success) {
        console.log("Installing dtach via brew...")
        const r = exec("brew", ["install", "dtach"])
        if (r.success && isDtachInstalled()) {
            return true
        }
    }

    return false
}

/**
 * List dtach session sockets in the state directory, enriched with
 * titles from persisted chatSessions.json when available.
 */
export function listDtachSockets() {
    const results = []
    try {
        for (const entry of Deno.readDirSync(paths.STATE_DIR)) {
            const m = entry.name.match(/^dtach-(.+)\.sock$/)
            if (m) {
                results.push({ id: m[1], socketPath: paths.dtachSockFile(m[1]), title: null })
            }
        }
    } catch {
        // ignore
    }

    // Enrich with titles from persisted session data
    try {
        const raw = Deno.readTextFileSync(paths.persistenceFile("chatSessions"))
        const sessions = JSON.parse(raw)
        for (const entry of results) {
            const sess = sessions[entry.id]
            if (sess?.title) {
                entry.title = sess.title
            }
        }
    } catch {
        // chatSessions.json may not exist yet — no titles, that's fine
    }

    // Prefer topic name over session title when the session is bound
    // to a command center topic — the topic name is more meaningful
    // to the user than the auto-derived session title.
    try {
        const raw = Deno.readTextFileSync(paths.persistenceFile("chatState"))
        const chatState = JSON.parse(raw)
        const cc = chatState.commandCenter ?? {}
        const topicMap = cc.topicMap ?? {}
        const topicNames = cc.topicNames ?? {}
        for (const entry of results) {
            const threadId = topicMap[entry.id]
            if (threadId && topicNames[threadId]) {
                entry.title = topicNames[threadId]
            }
        }
    } catch {
        // chatState.json may not exist — no topic names, that's fine
    }

    return results
}

/**
 * Resolve a name (session ID or title) to a session ID.
 * Returns the ID if it matches directly, or searches titles.
 * Returns null if not found.
 */
export function resolveSessionName(name) {
    const sockets = listDtachSockets()

    // Direct ID match
    for (const s of sockets) {
        if (s.id === name) { return s.id }
    }

    // Title match (case-insensitive)
    const lower = name.toLowerCase()
    for (const s of sockets) {
        if (s.title && s.title.toLowerCase() === lower) { return s.id }
    }

    // Partial title match
    const partials = sockets.filter(s => s.title && s.title.toLowerCase().includes(lower))
    if (partials.length === 1) { return partials[0].id }

    return null
}

/**
 * Create a new dtach session running Claude Code with telegram channel.
 *
 * @param {string|undefined} title - Display title for the session
 * @param {string[]} extraClaudeArgs - Additional args passed through to the claude CLI
 */
export function createSession(title, extraClaudeArgs = []) {
    Deno.mkdirSync(paths.STATE_DIR, { recursive: true })

    const sessionId = generateName()
    const dtachSock = paths.dtachSockFile(sessionId)
    const logFile = paths.dtachLogFile(sessionId)

    const info = { id: sessionId, dtachSocket: dtachSock }
    if (title) {
        info.title = title
    }
    Deno.writeTextFileSync(paths.NEXT_SESSION_FILE, JSON.stringify(info))

    console.log(`Session ID: ${sessionId}`)
    console.log(`dtach socket: ${dtachSock}`)
    console.log("Detach with Ctrl+\\")
    console.log()

    // --channels is always included; extra args are passed through to claude as-is
    const claudeArgs = [
        "--channels", "plugin:telegram@claude-plugins-official",
        ...extraClaudeArgs,
    ]

    // Run dtach piped through tee (tee on the outside preserves the pty for claude)
    const result = new Deno.Command("bash", {
        args: ["-c", `dtach -c "$1" -z claude ${claudeArgs.map(a => `'${a}'`).join(" ")} 2>&1 | tee "$2"`, "_", dtachSock, logFile],
        env: {
            ...Deno.env.toObject(),
            CBG_DTACH: "1",
            CBG_DTACH_SOCKET: dtachSock,
            CBG_SESSION_ID: sessionId,
        },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
    }).outputSync()
    Deno.exit(result.code)
}

/**
 * Attach to an existing dtach session.
 */
export function attachSession(id) {
    const dtachSock = paths.dtachSockFile(id)
    try {
        Deno.statSync(dtachSock)
    } catch {
        console.error(`No dtach socket found for session ${id}`)
        console.error(`Expected: ${dtachSock}`)
        Deno.exit(1)
    }

    const result = new Deno.Command("dtach", {
        args: ["-a", dtachSock],
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
    }).outputSync()
    Deno.exit(result.code)
}
