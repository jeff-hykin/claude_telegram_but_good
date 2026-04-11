/**
 * Shared IPC protocol helpers for the standalone Telegram server
 * and MCP shim communication.
 *
 * Transport: Unix domain socket at ~/.local/share/cbg/state/ipc.sock
 * Framing: Newline-delimited JSON
 */

import { join, sibling } from "../imports.js"

export const HOME = Deno.env.get("HOME")

// ── Central path definitions ────────────────────────────────────────
// All paths used by cbg should be defined here.
// Some shell scripts duplicate these paths and cannot import from JS:
//   - run/hook            duplicates LOCAL_REPO
//   - lib/shim.js (shell) duplicates STATE_DIR
// If you change a path here, grep for the old value in shell scripts.
// ────────────────────────────────────────────────────────────────────

// cbg install location (cloned repo)
export const LOCAL_REPO = join(HOME, ".local", "share", "cbg", "plugin")

// runtime state (sockets, pids, access control)
export const STATE_DIR = Deno.env.get("TELEGRAM_STATE_DIR") ?? join(HOME, ".local", "share", "cbg", "state")
export const ACCESS_FILE = join(STATE_DIR, "access.json")
export const APPROVED_DIR = join(STATE_DIR, "approved")
export const ENV_FILE = join(STATE_DIR, ".env")
export const IPC_SOCK = join(STATE_DIR, "ipc.sock")
export const INBOX_DIR = join(STATE_DIR, "inbox")
export const PID_FILE = join(STATE_DIR, "server.pid")
export const STOPPED_FILE = join(STATE_DIR, "server.stopped")

// hook entry point (registered in ~/.claude/settings.json)
export const HOOK_PATH = join(LOCAL_REPO, "run", "hook")

// user-facing custom commands directory
export const CUSTOM_COMMANDS_DIR = join(HOME, ".claude", "telegram", "custom_commands")

// config
export const CONFIG_DIR = join(HOME, ".config", "cbg")
export const CONFIG_FILE = join(CONFIG_DIR, "config.yaml")

// logging (also hardcoded in skills/logs/SKILL.md)
export const LOG_FILE = join(STATE_DIR, "main.log")

const encoder = new TextEncoder()

// ── Shared utilities ───────────────────────────────────────────────

export function randomHex(bytes) {
    const arr = new Uint8Array(bytes)
    crypto.getRandomValues(arr)
    return Array.from(arr, b => b.toString(16).padStart(2, "0")).join("")
}

export function execSync(cmd) {
    const result = new Deno.Command("sh", {
        args: ["-c", cmd],
        stdout: "piped",
        stderr: "piped",
    }).outputSync()
    return new TextDecoder().decode(result.stdout).trim()
}

// Sentinel sent in hook events when the Claude PID can't be determined.
// The server fail-safes by displaying any hook tagged with this value
// regardless of which session is currently focused.
export const UNKNOWN_CLAUDE_PID = "UNKNOWN"

/**
 * Walk up the process tree looking for the Claude Code PID. Returns the PID
 * if a `claude` process is found in the ancestry, or null if not.
 *
 * Match is on the full command line (`ps -o args=`), not `comm`: the kernel's
 * `comm` field is truncated to 15 chars and shows only the interpreter for
 * shell scripts — e.g. a `claude` shim script reports comm=`sh`, never
 * `claude`.
 */
export function findClaudePidStrict(startPid) {
    const getppid = (pid) => {
        const r = execSync(`ps -o ppid= -p ${pid}`)
        return r ? parseInt(r) : -1
    }
    const getargs = (pid) => execSync(`ps -o args= -p ${pid}`) || "?"

    let pid = startPid ?? Deno.pid
    for (let i = 0; i < 10; i++) {
        pid = getppid(pid)
        if (pid <= 1) {
            break
        }
        const args = getargs(pid)
        dbg("PID-WALK", `ancestry walk: pid=${pid} args=${args}`)
        if (/\/claude(\s|$)/i.test(args)) {
            dbg("PID-WALK", `found Claude Code at PID ${pid}`)
            return pid
        }
    }
    return null
}

/**
 * Walk up the process tree to find the Claude Code PID, falling back to the
 * immediate ppid if no claude process is found in the ancestry. Used by the
 * shim where some PID is required for registration. The hook prefers
 * findClaudePidStrict + the UNKNOWN_CLAUDE_PID sentinel so the server can
 * route fail-safe events.
 */
export function findClaudePid(startPid) {
    const found = findClaudePidStrict(startPid)
    if (found != null) {
        return found
    }
    const getppid = (pid) => {
        const r = execSync(`ps -o ppid= -p ${pid}`)
        return r ? parseInt(r) : -1
    }
    const ppid = getppid(startPid ?? Deno.pid)
    dbg("PID-WALK", "could not find claude in ancestry, falling back to ppid:", ppid)
    return ppid > 0 ? ppid : (startPid ?? Deno.pid)
}

export function getPluginVersion(meta) {
    try {
        return JSON.parse(Deno.readTextFileSync(sibling(meta, ".claude-plugin/plugin.json"))).version
    } catch {
        return "unknown"
    }
}

export function sendIpc(conn, msg) {
    try {
        conn.write(encoder.encode(JSON.stringify(msg) + "\n"))
    } catch {
        // connection may be closed
    }
}

/**
 * Parse newline-delimited JSON from a socket data stream.
 * Returns parsed messages and the remaining buffer.
 */
export function parseIpcMessages(buf, chunk) {
    buf += chunk
    const messages = []
    let nl
    while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        try {
            messages.push(JSON.parse(line))
        } catch {
            // skip malformed lines
        }
    }
    return { messages, remaining: buf }
}

// Debug logging
const DEBUG = true

export function dbg(label, ...args) {
    if (!DEBUG) {
        return
    }
    const ts = new Date().toISOString()
    const line = `[TG-DBG ${ts}] ${label}: ${args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ")}\n`
    Deno.stderr.writeSync(encoder.encode(line))
    try {
        Deno.writeTextFileSync(LOG_FILE, line, { append: true })
    } catch {
        // ignore
    }
}
