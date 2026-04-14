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
 * Boot-time modules are plain static imports: main-server.js runs once
 * per daemon process and never hot-reloads, so versionedImport at the
 * top level was a no-op. Hot reload is still available to modules
 * loaded INSIDE callbacks (eventLoop, IPC read loop, bot.onMessage,
 * shutdown) — those still use versionedImport so a `cbgVersion` bump
 * cascades through the event-processor graph on the next event.
 */

import { fromFileUrl } from "./imports.js"
// lib/version.js self-initializes globalThis.cbgVersion on import.
import { versionedImport } from "./lib/version.js"

// main-server.js is the shell — it runs once per daemon process and
// NEVER hot-reloads itself. This is the one place where top-level
// versionedImport calls are no-ops (they can't run more than once),
// so every boot-time module is a plain static import. Modules loaded
// inside callbacks (eventLoop, onMessage, IPC read, shutdown) still
// use versionedImport — that's where hot reload actually takes effect.
import { paths } from "./lib/paths.js"
import { dbg } from "./lib/logging.js"
import {
    getBotToken,
    getConfig,
    getEventQueueMax,
    getHandlerWarnMs,
} from "./lib/config-manager.js"
import { loadPersistedState, setCoreRef as setPersistenceCoreRef } from "./lib/effects/persistence.js"
import { stripFieldsResetOnRestartFromAllSessions } from "./lib/pure/field-stripper.js"
import { loadCommands, getCommandDescriptions } from "./lib/hot-commands.js"
import { startShimWatcher } from "./lib/effects/shim-watcher.js"
import { TelegramBot } from "./lib/bot/telegram-bot.js"
import { DiscordBot } from "./lib/bot/discord-bot.js"

// Ensure the state directory exists — it's the parent of ipc.sock / pid file
try {
    Deno.mkdirSync(paths.STATE_DIR, { recursive: true })
} catch (e) {
    dbg("MAIN", "mkdir paths.STATE_DIR:", e)
}

// Clear any stale `server.stopped` soft-stop marker. The invariant is:
// "if main-server.js is running, server.stopped must not exist." Normally
// the CLI commands (cbg start / restart / reinstall) clear it, but any
// crash-kill-restart path that bypasses the CLI — launchctl relaunching
// the service after a crash, a manual `deno run main-server.js`, etc. —
// would otherwise leave the marker in place and block shims from
// registering (they read server.stopped and politely wait forever).
// Removing it here makes the invariant self-healing: whoever boots the
// daemon can't leave the marker behind by accident.
try {
    Deno.removeSync(paths.STOPPED_FILE)
    dbg("MAIN", "cleared stale server.stopped marker on boot")
} catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
        dbg("MAIN", "remove STOPPED_FILE on boot:", e)
    }
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
        // Strip live-runtime fields from every persisted session. The
        // canonical list lives in lib/pure/field-stripper.js
        // so any new live-runtime field added to the session shape has
        // exactly one place to register itself. Currently drops:
        //   _conn, activeSpinner, status, agentRequest, agentRequestStartedAt,
        //   pendingNudgeAction, screenBufferRecord.
        // Persistent fields (id, pid, cwd, title, gitBranch, dtachSocket,
        // longTaskId, lastInbound/lastOutboundAt/lastStopAt/lastActive)
        // survive — the reconnecting shim and any still-live long task
        // continue from where they left off.
        chatSessions = stripFieldsResetOnRestartFromAllSessions(loaded.chatSessions)

        // Liveness probe. A session that made it into chatSessions.json
        // belonged to a shim that was alive at last persist. On reload,
        // the shim is either (a) still running with its dtach socket
        // intact and will reconnect, (b) still running but with a dead
        // socket file (shim crashed / dtach force-killed), or (c) fully
        // gone. Drop (b) and (c) here so /list doesn't accumulate
        // zombies forever. The reconnect loop in mcp-shim.js handles
        // (a) — it'll re-register and show up again.
        for (const [sid, sess] of Object.entries(chatSessions)) {
            if (!sess) { continue }
            const sock = sess.dtachSocket
            if (typeof sock !== "string" || sock.length === 0) {
                dbg("MAIN", `liveness probe: ${sid} has no dtachSocket — dropping zombie`)
                delete chatSessions[sid]
                continue
            }
            try {
                Deno.statSync(sock)
            } catch (e) {
                if (e instanceof Deno.errors.NotFound) {
                    dbg("MAIN", `liveness probe: ${sid} dtach socket missing (${sock}) — dropping zombie`)
                    delete chatSessions[sid]
                    continue
                }
                dbg("MAIN", `liveness probe: ${sid} stat ${sock} failed:`, e)
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
setPersistenceCoreRef(core)

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
    while (true) {
        let conn
        try {
            conn = await ipcListener.accept()
        } catch (e) {
            if (e instanceof Deno.errors.BadResource) {
                dbg("IPC", "listener closed, exiting accept loop")
                break
            }
            dbg("IPC", "accept failed, continuing:", e)
            continue
        }
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
        const { translateIpcMessage } = await versionedImport("./lib/pure/ipc-inbound.js", import.meta)
        const events = translateIpcMessage(msg, conn, core) ?? []
        for (const ev of events) { enqueueEvent(ev) }
    } catch (e) {
        dbg("IPC", "translator failed:", e)
    }
}

// ── Live shim file watcher ────────────────────────────────────────────
// Deno.watchFs() on the parent dir of $PATH/claude — when Claude Code
// auto-updates and clobbers our shim, we reinstall within ~200 ms.
// The safety-net poller in lib/shim-health.js (throttled to 5 min) is
// the fallback if the watcher crashes or the platform misbehaves. See
// lib/effects/shim-watcher.js.
dbg("MAIN", `shim watcher: ${startShimWatcher(core).enabled ? "started" : "disabled"}`)

// ── Chat bot ───────────────────────────────────────────────────────────
// Everything goes through the abstract Bot / TelegramBot split in
// lib/bot/. Effects and event handlers call `core.bot.sendText(...)`,
// `core.bot.editText(...)`, etc. — the platform-specific calls are
// contained inside each adapter (TelegramBot / DiscordBot / ...).
//
// The adapter is picked by `config.bot_platform` (default "telegram").
const platform = getConfig().bot_platform ?? "telegram"
const bot = await startChatBot(platform)
if (bot) {
    core.bot = bot
    // Publish the current slash-command menu to the platform.
    // Replacement-style: whatever's in the registry right now IS the
    // menu after this call, so stale commands from older versions
    // (including anything a previous BotFather session added by hand)
    // get cleaned up on every boot.
    try {
        const entries = [...getCommandDescriptions().entries()].map(
            ([command, description]) => ({ command, description }),
        )
        if (entries.length > 0) {
            const ok = await bot.setCommands(entries)
            dbg("MAIN", `published ${entries.length} slash commands to ${platform} (ok=${ok})`)
        }
    } catch (e) {
        dbg("MAIN", "setCommands failed:", e)
    }
}

async function startChatBot(platform) {
    // IMPORTANT: both TelegramBot.start() and DiscordBot.start() resolve
    // when their respective "ready" signal fires (Grammy's `onStart`, the
    // Discord gateway's READY dispatch) — not when the underlying poll/
    // websocket eventually closes. So we can `await` them inline: by the
    // time this function returns the bot, it's guaranteed connected and
    // ready to receive `sendText` calls. If we fire-and-forgot `start()`
    // instead, an inbound IPC event arriving during the connect window
    // would hit `core.bot.sendText()` before the adapter was ready and
    // trip the `_assertStarted` guard.
    if (platform === "discord") {
        const token = getConfig().discord_bot_token
        if (!token) {
            dbg("MAIN", "bot_platform=discord but discord_bot_token is unset — IPC-only mode")
            return null
        }
        const bot = new DiscordBot({ token })
        bot.onMessage(async (ctx) => {
            try {
                const { translateTelegramMessage } = await versionedImport("./lib/pure/telegram-translator.js", import.meta)
                const events = translateTelegramMessage(ctx) ?? []
                for (const ev of events) { enqueueEvent(ev) }
            } catch (e) {
                dbg("DISCORD", "translator failed:", e)
            }
        })
        try {
            await bot.start()
            dbg("MAIN", "Discord bot started")
        } catch (e) {
            dbg("MAIN", "Discord bot failed:", e)
            return null
        }
        return bot
    }

    // Default: Telegram.
    const token = getBotToken()
    if (!token) {
        dbg("MAIN", "no bot token — starting in IPC-only mode")
        return null
    }
    const bot = new TelegramBot({ token })
    bot.onMessage(async (ctx) => {
        try {
            const { translateTelegramMessage } = await versionedImport("./lib/pure/telegram-translator.js", import.meta)
            const events = translateTelegramMessage(ctx) ?? []
            for (const ev of events) { enqueueEvent(ev) }
        } catch (e) {
            dbg("TG", "translator failed:", e)
        }
    })
    try {
        await bot.start()
        dbg("MAIN", "Grammy bot started")
    } catch (e) {
        dbg("MAIN", "Grammy bot failed:", e)
        return null
    }
    return bot
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

// ── Stall-detector bootstrap ───────────────────────────────────────────
// Kick off the periodic screen-snapshot tick. The handler itself
// re-schedules another tick every iteration, so this is the ONE event
// the shell needs to seed. See lib/event-handlers/screen-snapshot.js
// and lib/event-handlers/stall-check.js for the detector pair.
enqueueEvent({ type: "screen_snapshot_tick" })

// ── Go ─────────────────────────────────────────────────────────────────
dbg("MAIN", `main-server ready (cbgVersion=${globalThis.cbgVersion}, pid=${Deno.pid})`)
await eventLoop()
