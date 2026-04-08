/**
 * dtach session helpers: install check, create, attach, list.
 */

import { join } from "../imports.js"
import { STATE_DIR } from "./protocol.js"

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

function randomHex(bytes) {
    const arr = new Uint8Array(bytes)
    crypto.getRandomValues(arr)
    return Array.from(arr, b => b.toString(16).padStart(2, "0")).join("")
}

/**
 * List dtach session sockets in the state directory.
 */
export function listDtachSockets() {
    const results = []
    try {
        for (const entry of Deno.readDirSync(STATE_DIR)) {
            const m = entry.name.match(/^dtach-([a-f0-9]+)\.sock$/)
            if (m) {
                results.push({ id: m[1], socketPath: join(STATE_DIR, entry.name) })
            }
        }
    } catch {
        // ignore
    }
    return results
}

/**
 * Create a new dtach session running Claude Code with telegram channel.
 *
 * @param {string|undefined} title - Display title for the session
 * @param {string[]} extraClaudeArgs - Additional args passed through to the claude CLI
 */
export function createSession(title, extraClaudeArgs = []) {
    Deno.mkdirSync(STATE_DIR, { recursive: true })

    const sessionId = randomHex(3)
    const dtachSock = join(STATE_DIR, `dtach-${sessionId}.sock`)

    const info = { id: sessionId, dtachSocket: dtachSock }
    if (title) {
        info.title = title
    }
    Deno.writeTextFileSync(join(STATE_DIR, "next_session.json"), JSON.stringify(info))

    console.log(`Session ID: ${sessionId}`)
    console.log(`dtach socket: ${dtachSock}`)
    console.log("Detach with Ctrl+\\")
    console.log()

    // --channels is always included; extra args are passed through to claude as-is
    const claudeArgs = [
        "--channels", "plugin:telegram@claude-plugins-official",
        ...extraClaudeArgs,
    ]

    const result = new Deno.Command("dtach", {
        args: ["-c", dtachSock, "-z", "claude", ...claudeArgs],
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
    const dtachSock = join(STATE_DIR, `dtach-${id}.sock`)
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
