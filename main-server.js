#!/usr/bin/env -S deno run -A
/**
 * main-server.js — the event-loop shell for the CBG daemon.
 *
 * This is the long-lived process that owns:
 *   - The Grammy Telegram bot
 *   - The Unix-socket IPC listener (shims, hook scripts, CLI clients)
 *   - The event queue
 *   - The central state objects (chatState, chatSessions, specialData)
 *
 * Everything else lives in lib/ and is loaded via `versionedImport`
 * so it can be hot-reloaded without killing the daemon or any Claude
 * sessions.
 *
 * The shell itself has only ONE static lib import: `versionedImport`
 * from lib/version.js. Everything else comes through versionedImport
 * calls so reload cascades through the whole module graph.
 */

import { Bot, fromFileUrl } from "./imports.js"
import { versionedImport, VERSION } from "./lib/version.js"

// Initialize the version from the compile-time VERSION constant in
// lib/version.js. The `bump_cbg_version` effect rewrites version.js on
// disk, so a restarted daemon picks up the latest value automatically.
globalThis.cbgVersion = VERSION

// ── Bootstrap: load path constants + utilities via versionedImport ────
const { paths } = await versionedImport("./lib/paths.js", import.meta)
const { dbg } = await versionedImport("./lib/logging.js", import.meta)
const {
    getBotToken,
    getEventQueueMax,
    getHandlerWarnMs,
} = await versionedImport("./lib/config-manager.js", import.meta)

// Ensure the state directory exists — it's the parent of ipc.sock / pid file
try {
    Deno.mkdirSync(paths.STATE_DIR, { recursive: true })
} catch (e) {
    dbg("MAIN", "mkdir paths.STATE_DIR:", e)
}

// ── Central state ──────────────────────────────────────────────────────
// ONLY onEvent writes to these. Handlers return descriptions; onEvent
// applies them via mergeSessionData and the tooling layer.
//
// On boot we try to load chatState.json / chatSessions.json / specialData.json
// from disk (written by flushPersistenceNow on a previous shutdown). Any
// slice that can't be loaded defaults to the empty shape below. IPC
// connections (`_conn`) are NOT persisted; sessions show as "disconnected"
// until their shim re-registers.
const _defaultChatState = {
    focusedSessionId: null,
    pendingFocusId: null,
    pendingOtps: {},
    pendingPermissions: {},
    stats: { eventsProcessed: 0, queueDepth: 0 },
}
const _defaultSpecialData = {
    longTaskByChatId: {},
    telegramMessagesByChatId: {},
}

let chatState = { ..._defaultChatState }
let chatSessions = {}
let specialData = { ..._defaultSpecialData }

try {
    const { loadPersistedState } = await versionedImport("./lib/effects/persistence.js", import.meta)
    const loaded = loadPersistedState()
    if (loaded.chatState && typeof loaded.chatState === "object") {
        chatState = { ..._defaultChatState, ...loaded.chatState }
        // pendingPermissions and pendingOtps are intrinsically tied to the
        // IPC conn of the process that registered them. The persistence
        // layer strips `_conn` on write, so any entry loaded here has no
        // way to reply to its worker — a tap on an Allow/Deny button
        // would try to write to `undefined` and the tool call would hang
        // forever. Discard them on load; the worker/CLI can re-issue.
        chatState.pendingPermissions = {}
        chatState.pendingOtps = {}
    }
    if (loaded.chatSessions && typeof loaded.chatSessions === "object") {
        // Drop _conn and activeSpinner from any loaded session:
        //   - _conn is a stale reference from the previous process and is
        //     re-populated when the shim re-registers.
        //   - activeSpinner carries a Telegram messageId that the shim
        //     would otherwise try to edit on its first hook after
        //     reconnecting; that message has been static on the user's
        //     screen since the old process died and every edit would
        //     either no-op or fail. The next inbound user message will
        //     start a fresh spinner.
        chatSessions = {}
        for (const [sid, sess] of Object.entries(loaded.chatSessions)) {
            if (sess && typeof sess === "object") {
                // eslint-disable-next-line no-unused-vars
                const { _conn, activeSpinner, ...rest } = sess
                chatSessions[sid] = rest
            }
        }
    }
    if (loaded.specialData && typeof loaded.specialData === "object") {
        specialData = { ..._defaultSpecialData, ...loaded.specialData }
    }
    dbg("MAIN", `loaded persisted state: ${Object.keys(chatSessions).length} sessions, ${Object.keys(specialData.longTaskByChatId ?? {}).length} chats with tasks`)
} catch (e) {
    dbg("MAIN", "persistence load failed, using defaults:", e)
}

// ── Event queue ────────────────────────────────────────────────────────
// MAX_QUEUE and the slow-handler warning threshold are fresh-read from
// config-manager at every point of use, so editing config.json hot-reloads
// the value without bouncing the daemon.

const eventQueue = []
let wakeup = null

function wake() {
    if (wakeup) {
        const w = wakeup
        wakeup = null
        w()
    }
}

function enqueueEvent(event) {
    if (!event || typeof event.type !== "string") {
        dbg("QUEUE", "refusing to enqueue malformed event:", event)
        return
    }
    const maxQueue = getEventQueueMax()
    if (eventQueue.length >= maxQueue) {
        const before = eventQueue.length
        for (let i = eventQueue.length - 1; i >= 0; i--) {
            const t = eventQueue[i].type
            if (t === "claude_hook_pre_tool_use" || t === "claude_hook_post_tool_use") {
                eventQueue.splice(i, 1)
            }
        }
        const purged = before - eventQueue.length
        dbg("QUEUE", `ALERT: queue at cap (${before}/${maxQueue}), purged ${purged} tool-call events, depth=${eventQueue.length}`)
        if (eventQueue.length >= maxQueue) {
            dbg("QUEUE", `ALERT: queue still full after purge, dropping event type=${event.type}`)
            return
        }
    }
    event.ts = event.ts ?? Date.now()
    eventQueue.push(event)
    wake()
}

/**
 * Insert an event at the FRONT of the queue. Used by timers that want
 * their fired event to jump past other queued events ("high priority").
 */
function enqueueEventFront(event) {
    if (!event || typeof event.type !== "string") {
        dbg("QUEUE", "refusing to front-enqueue malformed event:", event)
        return
    }
    event.ts = event.ts ?? Date.now()
    eventQueue.unshift(event)
    wake()
}

// ── Core kernel ────────────────────────────────────────────────────────
// Handed to onEvent and to handlers. Getters/setters for mutable state
// so applyAction can re-assign when mergeSessionData returns a new object.
const core = {
    get chatState() { return chatState },
    set chatState(v) { chatState = v },
    get chatSessions() { return chatSessions },
    set chatSessions(v) { chatSessions = v },
    get specialData() { return specialData },
    set specialData(v) { specialData = v },
    bot: null,          // set after bot is created
    ipcListener: null,  // set after listener is created
    ipcConns: new Map(),
    enqueueEvent,
    enqueueEventFront,
    get version() { return globalThis.cbgVersion },
}

// ── Wire persistence tooling to the core ──────────────────────────────
try {
    const persistenceMod = await versionedImport("./lib/effects/persistence.js", import.meta)
    persistenceMod.setCoreRef?.(core)
} catch (e) {
    dbg("MAIN", "persistence setCoreRef failed:", e)
}

// ── Load hot-reloadable Telegram commands ─────────────────────────────
// Walks <repo>/commands/*.js + ~/.claude/telegram/custom_commands/*.js
// and populates the in-memory command registry. `/reload` + `new_command`
// re-invoke this.
const COMMANDS_DIR = (() => {
    const here = fromFileUrl(new URL(".", import.meta.url))
    return here.replace(/\/+$/, "") + "/commands"
})()
// Expose so the reload_hot_commands effect can find the dir.
core.commandsDir = COMMANDS_DIR
try {
    const { loadCommands } = await versionedImport("./lib/hot-commands.js", import.meta)
    const { loaded, errors } = await loadCommands(COMMANDS_DIR)
    dbg("MAIN", `hot commands: ${loaded} loaded, ${errors.length} errors`)
    if (errors.length > 0) {
        for (const err of errors) {
            dbg("MAIN", "hot-command load error:", err)
        }
    }
} catch (e) {
    dbg("MAIN", "hot-command load failed:", e)
}

// ── Event loop ─────────────────────────────────────────────────────────
async function eventLoop() {
    while (true) {
        while (eventQueue.length === 0) {
            await new Promise(r => { wakeup = r })
        }
        const event = eventQueue.shift()
        chatState = { ...chatState, stats: { ...chatState.stats, queueDepth: eventQueue.length } }

        // Re-import onEvent every iteration so a version bump cascades
        // through the whole module graph on the NEXT event. This is the
        // core of hot reload.
        let onEvent
        try {
            const mod = await versionedImport("./lib/main-event-processor.js", import.meta)
            onEvent = mod.onEvent
        } catch (e) {
            dbg("MAIN", "failed to load main-event-processor:", e)
            continue
        }

        if (typeof onEvent !== "function") {
            dbg("MAIN", "main-event-processor.js has no onEvent export")
            continue
        }

        const start = Date.now()
        const warnMs = getHandlerWarnMs()
        const warnTimer = setTimeout(() => {
            dbg("MAIN", `WARN: handler for ${event.type} taking >${warnMs}ms`)
        }, warnMs)

        try {
            await onEvent(event, core)
        } catch (e) {
            dbg("MAIN", `onEvent threw for ${event.type}:`, e)
        } finally {
            clearTimeout(warnTimer)
            const elapsed = Date.now() - start
            if (elapsed > warnMs) {
                dbg("MAIN", `SLOW: ${event.type} took ${elapsed}ms`)
            }
        }
    }
}

// ── IPC listener ───────────────────────────────────────────────────────
// Unix socket. Shim connections (long-lived) + hook scripts (one-shot) +
// CLI clients (one-shot) all arrive here. We read newline-delimited JSON
// and dynamically import the translator to produce events.
try { Deno.removeSync(paths.IPC_SOCK) } catch (e) { dbg("IPC", "remove stale socket:", e) }
const ipcListener = Deno.listen({ transport: "unix", path: paths.IPC_SOCK })
core.ipcListener = ipcListener
dbg("MAIN", "IPC listening on", paths.IPC_SOCK)

;(async () => {
    for await (const conn of ipcListener) {
        spawnIpcReadLoop(conn)
    }
})()

function spawnIpcReadLoop(conn) {
    ;(async () => {
        const buf = new Uint8Array(8192)
        // Stateful: reuse across chunks so a multi-byte UTF-8 glyph
        // split across a read boundary reassembles correctly.
        const decoder = new TextDecoder("utf-8")
        let pending = ""
        while (true) {
            let n
            try {
                n = await conn.read(buf)
            } catch (e) {
                dbg("IPC", "read error:", e)
                break
            }
            if (n == null) { break }
            const chunk = decoder.decode(buf.subarray(0, n), { stream: true })
            const { parseIpcMessages } = await versionedImport("./lib/ipc.js", import.meta)
            const { messages, remaining } = parseIpcMessages(pending, chunk)
            pending = remaining
            for (const msg of messages) {
                await enqueueIpcMessage(msg, conn)
            }
        }
        enqueueEvent({ type: "ipc_connection_closed", _conn: conn })
    })()
}

async function enqueueIpcMessage(msg, conn) {
    try {
        const { translateIpcMessage } = await versionedImport("./lib/ipc-inbound.js", import.meta)
        const events = translateIpcMessage(msg, conn, core) ?? []
        for (const ev of events) { enqueueEvent(ev) }
    } catch (e) {
        dbg("IPC", "translator failed:", e)
    }
}

// ── Telegram bot ───────────────────────────────────────────────────────
const botToken = getBotToken()
if (!botToken) {
    dbg("MAIN", "no bot token — starting in IPC-only mode")
} else {
    const bot = new Bot(botToken)
    core.bot = bot

    const enqueueFromTelegram = async (ctx) => {
        try {
            const { translateTelegramMessage } = await versionedImport("./lib/pure/telegram-translator.js", import.meta)
            const events = translateTelegramMessage(ctx) ?? []
            for (const ev of events) { enqueueEvent(ev) }
        } catch (e) {
            dbg("TG", "translator failed:", e)
        }
    }

    bot.on("message:text", enqueueFromTelegram)
    bot.on("message:photo", enqueueFromTelegram)
    bot.on("message:document", enqueueFromTelegram)
    bot.on("message:voice", enqueueFromTelegram)
    bot.on("message:audio", enqueueFromTelegram)
    bot.on("message:video", enqueueFromTelegram)
    bot.on("message:video_note", enqueueFromTelegram)
    bot.on("message:sticker", enqueueFromTelegram)
    bot.on("callback_query:data", enqueueFromTelegram)

    ;(async () => {
        try {
            await bot.start({
                onStart: () => dbg("MAIN", "Grammy bot started"),
            })
        } catch (e) {
            dbg("MAIN", "Grammy bot failed:", e)
        }
    })()
}

// ── Shutdown ───────────────────────────────────────────────────────────
async function shutdown() {
    dbg("MAIN", "shutdown requested")
    try {
        const { flushPersistenceNow } = await versionedImport("./lib/effects/persistence.js", import.meta)
        flushPersistenceNow?.()
    } catch (e) {
        dbg("MAIN", "flush on shutdown failed:", e)
    }
    try { ipcListener.close() } catch (e) { dbg("MAIN", "listener close:", e) }
    try { Deno.removeSync(paths.IPC_SOCK) } catch (e) { dbg("MAIN", "socket rm:", e) }
    try { Deno.removeSync(paths.PID_FILE) } catch (e) { dbg("MAIN", "pid rm:", e) }
    Deno.exit(0)
}
Deno.addSignalListener("SIGTERM", shutdown)
Deno.addSignalListener("SIGINT", shutdown)

// ── PID file for lifecycle management ──────────────────────────────────
Deno.writeTextFileSync(paths.PID_FILE, String(Deno.pid))

// ── Go ─────────────────────────────────────────────────────────────────
dbg("MAIN", `main-server ready (cbgVersion=${globalThis.cbgVersion}, pid=${Deno.pid})`)
await eventLoop()
