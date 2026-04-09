/**
 * Shared IPC protocol helpers for the standalone Telegram server
 * and MCP shim communication.
 *
 * Transport: Unix domain socket at ~/.local/share/cbg/state/ipc.sock
 * Framing: Newline-delimited JSON
 */

import { join } from "../imports.js"

const HOME = Deno.env.get("HOME")

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

/**
 * Async generator that reads IPC messages from a Deno.UnixConn.
 */
export async function* readIpcMessages(conn) {
    const buf = new Uint8Array(8192)
    const decoder = new TextDecoder()
    let remainder = ""
    while (true) {
        let n
        try {
            n = await conn.read(buf)
        } catch {
            break
        }
        if (n === null) {
            break
        }
        const result = parseIpcMessages(remainder, decoder.decode(buf.subarray(0, n)))
        remainder = result.remaining
        for (const msg of result.messages) {
            yield msg
        }
    }
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
