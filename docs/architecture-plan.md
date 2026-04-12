# Event Loop Architecture Plan (v2)

Refactor the daemon from scattered handlers + setIntervals into a single
serialized event loop that is **fully hot-reloadable** (update code
without killing any Claude sessions).

## Why

Today:
- Grammy bot, IPC listener, and `setInterval`s all mutate state directly.
  Races, ordering surprises, and scattered logic.
- Code changes require restarting `standalone-server.js`, which kills
  all shim connections and breaks every active Claude session's
  Telegram link.
- No single place to reason about state.

After:
- **One process, one queue, one `onEvent`.** Every external stimulus is
  an event. Events are processed in strict FIFO order.
- **Mostly-pure handlers.** Handlers read state + event, return a
  description of what to change and what to do. `onEvent` applies the
  description via a small standard tooling layer.
- **Hot-reloadable.** The daemon's outer shell is ~100 lines and never
  changes. All logic lives in modules imported dynamically with a
  version-salted URL. Reload bumps the version and the next
  `onEvent` call pulls fresh code across the whole import graph. The
  shim (MCP server) also re-imports its handler code per tool call, so
  mid-session reloads are safe.

---

## Core primitives

### 1. The event queue

```js
// main-server.js (the outer shell, stays stable)
const eventQueue = []
let wakeup = null

function enqueueEvent(event) {
    if (eventQueue.length >= MAX_QUEUE) {
        purgeToolCallEvents(eventQueue)
        dbg("QUEUE", "queue at cap, purged tool-call events, depth =", eventQueue.length)
        if (eventQueue.length >= MAX_QUEUE) {
            dbg("QUEUE", "ALERT: queue still full after purge, dropping event", event.type)
            return
        }
    }
    eventQueue.push(event)
    if (wakeup) { wakeup(); wakeup = null }
}

async function eventLoop() {
    while (true) {
        while (eventQueue.length === 0) {
            await new Promise(r => { wakeup = r })
        }
        const event = eventQueue.shift()
        const { onEvent } = await import(`./lib/event-loop.js?v=${globalThis.cbgVersion}`)

        const start = Date.now()
        const deadline = setTimeout(() => {
            dbg("EVENT", `WARN: handler for ${event.type} taking >${HANDLER_WARN_MS}ms`)
        }, HANDLER_WARN_MS)

        try {
            await onEvent(event, core)
        } catch (e) {
            dbg("EVENT", `onEvent failed for ${event.type}:`, e)
        } finally {
            clearTimeout(deadline)
            const elapsed = Date.now() - start
            if (elapsed > HANDLER_WARN_MS) {
                dbg("EVENT", `SLOW: ${event.type} took ${elapsed}ms`)
            }
        }
    }
}
```

Guarantees:
- **Only one `onEvent` call is active at a time.** Strict FIFO order.
- **Hard cap with graceful degradation.** `MAX_QUEUE` (default 128,
  configurable) triggers a purge of tool-call events (PreToolUse,
  PostToolUse) — the low-signal, high-volume events. If still full, we
  drop and alert.
- **Handlers must react quickly.** A handler running longer than
  `HANDLER_WARN_MS` (default 20 s, configurable) logs a warning. This
  is a design constraint: handlers NEVER block waiting for an external
  event. If they need to wait, they enqueue a follow-up event.
- **Errors don't kill the loop.** Each event is try/caught.

### 2. The core kernel

Passed to `onEvent` as the second argument. Contains everything handlers
need access to (indirectly, through tooling):

```js
const core = {
    // State objects (read by handlers, written only by onEvent)
    chatState,
    chatSessions,
    specialData,

    // Infrastructure (stable across reloads, owned by the shell)
    bot,                   // Grammy bot instance
    ipcListener,           // Unix socket listener (handles shims + CLI clients)
    ipcConns: new Map(),   // sessionId → UnixConn (shim conns only)

    // Queue control (used by follow-up events, timers)
    enqueueEvent,

    // Versioning
    get version() { return globalThis.cbgVersion },
}
```

---

## Reloadability

### The problem

The daemon is long-running and owns sockets (Grammy's Telegram long-poll,
IPC Unix socket). Killing it disconnects every shim. We want to update
code without killing connections.

### The solution

The daemon is split into two parts:

1. **Outer shell (`main-server.js`, stays stable):** ~100 lines. Owns
   sockets, the event queue, the event loop. Imports nothing from
   `lib/` statically — all imports happen dynamically per-event with
   version salting.
2. **Reloadable code (everything in `lib/`):** imported with
   `?v=${globalThis.cbgVersion}` so each version gets a fresh module
   graph.

### Version salting

```js
// Anywhere in reloadable code that imports other reloadable code:
const { foo } = await import(`./bar.js?v=${globalThis.cbgVersion}`)
```

Rules:
- **`lib/*.js` imports use `?v=${globalThis.cbgVersion}`.** Static
  imports at the top of a reloadable module are fine ONLY if the
  module itself never needs to see updates from its dependencies
  mid-session. In practice: use dynamic imports everywhere inside
  reloadable code. Yes, this is ugly. Deno caches each URL as a
  separate module, so the overhead is one `await import` per call
  site after the first cache warm-up.
- **Custom commands use `?v=${randomHex()}`** (not `cbgVersion`) because
  custom commands live outside the CBG repo and have their own edit
  cycle independent of CBG versions.
- **`main-server.js` never imports from `lib/` statically.** It's the
  shell. Every call into reloadable code happens through a dynamic
  import.

### Bumping the version

```js
// lib/event-handlers/reload.js
export function handleReloadCommand(_event, _core) {
    globalThis.cbgVersion = (globalThis.cbgVersion ?? 1) + 1
    // Persist for cross-process consumers (shim.js)
    Deno.writeTextFileSync(CBG_VERSION_FILE, String(globalThis.cbgVersion))
    return {
        stateChanges: {},
        effects: [
            { type: "send_text_to_user", chatId: "ALL", text: `Reloaded cbg to version ${globalThis.cbgVersion}.` },
        ],
    }
}
```

The `cbg reload` CLI command sends a `reload_cbg` event via IPC. The
next event processed picks up the new version.

### Long-lived listeners across reloads

The daemon owns two long-lived listeners: Grammy's Telegram bot and the
Unix-socket IPC listener. **Both survive reloads.** The pattern:

- **Listener HANDLE is stable in the shell.** `bot` and `ipcListener`
  are created once at startup, held in `core`, and never re-created.
- **Message PROCESSING is reloadable via dynamic imports.** The raw
  bytes/message comes in, the shell does minimal parsing, then hands
  off to a reloadable translator that converts the raw message into an
  event.
- **Existing connections survive.** The per-connection read loop is
  shell code (stable, minimal). It reads JSON lines, calls a translator
  dynamically imported per message, and enqueues events.

```js
// main-server.js (stable shell)
const ipcListener = Deno.listen({ transport: "unix", path: IPC_SOCK })

;(async () => {
    for await (const conn of ipcListener) {
        spawnIpcReadLoop(conn)
    }
})()

function spawnIpcReadLoop(conn) {
    ;(async () => {
        const buf = new Uint8Array(8192)
        let pending = ""
        while (true) {
            let n
            try { n = await conn.read(buf) } catch { break }
            if (n == null) { break }
            pending += new TextDecoder().decode(buf.subarray(0, n))
            const lines = pending.split("\n")
            pending = lines.pop()
            for (const line of lines) {
                if (!line.trim()) { continue }
                await enqueueIpcMessage(line, conn)
            }
        }
        enqueueEvent({ type: "ipc_connection_closed", _conn: conn })
    })()
}

async function enqueueIpcMessage(line, conn) {
    // Reloadable translator — converts raw IPC JSON into events
    const { translateIpcMessage } = await import(
        `./lib/ipc-translator.js?v=${globalThis.cbgVersion}`
    )
    const events = translateIpcMessage(line, conn, core)
    for (const ev of events) { enqueueEvent(ev) }
}
```

Grammy follows the same pattern: `bot.on("message:text", ...)` is
registered once in the shell, but the callback body does
`await import("./lib/telegram-translator.js?v=${...}")` per message.

**Cost:** one dynamic import per message. Deno caches by URL, so within
one version all imports hit the cache. Bumping the version invalidates
the cache. Negligible overhead.

**What has to be stable in the shell:**
- `Deno.listen()` handle + accept loop
- Per-connection byte reader (read bytes, split on newlines)
- `enqueueEvent` itself
- Grammy `Bot` instance + `bot.on(...)` registrations

**What can reload freely:**
- `lib/ipc-translator.js` — raw IPC → event conversion
- `lib/telegram-translator.js` — Grammy ctx → event conversion
- Everything in `lib/event-handlers/`
- Everything in `lib/tooling/`

### Shim reloadability

`shim.js` runs inside the Claude Code process as an MCP server. It lives
for the lifetime of a session. When CBG is updated, running sessions
are using the OLD shim.js code.

Solution: the shim is a thin proxy. All its tool handlers use dynamic
imports:

```js
// shim.js (stable)
server.setRequestHandler(CallToolRequestSchema, async (req) => {
    await refreshCbgVersion()  // reads CBG_VERSION_FILE, updates globalThis.cbgVersion
    const { handleToolCall } = await import(`./lib/shim-tool-handler.js?v=${globalThis.cbgVersion}`)
    return await handleToolCall(req, shimContext)
})

async function refreshCbgVersion() {
    try {
        const v = Deno.readTextFileSync(CBG_VERSION_FILE).trim()
        if (v && v !== String(globalThis.cbgVersion)) {
            globalThis.cbgVersion = Number(v)
        }
    } catch { /* no version file yet */ }
}
```

`shim.js` itself is ~50 lines and never needs updates (it just forwards
tool calls to `shim-tool-handler.js` dynamically). If `shim.js` DOES
need a breaking change, sessions must be restarted — but that should be
rare.

### Hooks and CLI

Already fresh per invocation. `lib/hook.js` runs once per hook event via
`run/hook` bash wrapper, then exits. `mod.js` (CLI) is short-lived.
Neither needs version salting for the entry point, but any `lib/`
imports inside them should use `?v=${globalThis.cbgVersion}` for
consistency (the version they read comes from `CBG_VERSION_FILE`).

---

## Directory structure

```
main-server.js                  # outer shell (was: standalone-server.js)
shim.js                          # MCP shim (stable, thin proxy)
mod.js                           # CLI (thin, delegates to lib/)
imports.js                       # pinned esm.sh URLs (unchanged)

event_generators/                # all code that ENQUEUES events
    hooks/
        run-hook                 # bash wrapper (formerly run/hook)
        hook.js                  # reads Claude hook JSON, enqueues via IPC (formerly lib/hook.js)
    mcp-server/
        shim.js                  # symlink or re-export of top-level shim.js
        shim-tool-handler.js     # reloadable tool handler logic
    cli/
        mod.js                   # symlink or re-export of top-level mod.js
        commands/                # cbg subcommands (onboard, start, stop, etc.)

lib/                             # reloadable code (imported via ?v=)
    event-loop.js                # exports onEvent, dispatches by event.type
    ipc-translator.js            # raw IPC JSON → events (reloadable)
    telegram-translator.js       # Grammy ctx → events (reloadable)
    ipc-client.js                # CLI-side: connect, send message, await reply
    event-handlers/              # one handler per event type
        telegram-user.js
        telegram-callback-query.js
        claude-channel.js
        claude-hook-stop.js
        claude-hook-pre-tool-use.js
        claude-hook-post-tool-use.js
        session-register.js
        session-unregister.js
        ipc-connection-closed.js
        permission-request.js
        permission-response.js
        cli-command.js           # dispatches cli_command events by `kind`
        long-task-definition-submitted.js
        session-timer.js
        critic-verdict.js
        reload-cbg.js
        server-dump.js
    tooling/                     # side-effect implementations
        telegram-outbound.js     # sendTextMessageToUser, sendFileToUser, ...
        dtach-outbound.js        # sendTextToClaude, sendFilesToClaude
        session-lifecycle.js     # createHeadlessChat, closeChat
        timers.js                # setSessionTimer, clearSessionTimer
        critic-subprocess.js     # spawnCriticSubprocess
        ipc-outbound.js          # ipcRespond (writes to a UnixConn)
        persistence.js           # writeChatStateDump, writeSpecialData
    state-merge.js               # mergeSessionData (deep merge w/ undefined=delete)
    cold-storage.js              # append-only log read/write
    long-task.js                 # task dir helpers, slug gen
    // ... other pure helpers

commands/                        # hot-reloadable Telegram commands (unchanged)
```

---

## Central state

Three top-level objects. **Only `onEvent` writes to them.** Handlers
read them and return merge patches.

### 1. `chatSessions` — per-session state (hot, in-memory)

Keyed by shim session id (e.g. `"calmLion"`). Written to disk on shutdown
and reload; read from disk ONLY at startup. **The disk copy is NOT the
source of truth while running — it's a reload-survival snapshot.**

```js
{
    calmLion: {
        // Identity
        id: "calmLion",
        pid: 48291,
        cwd: "/Users/jeff/repos/x",
        title: "auth migration",
        gitBranch: "fix-auth",
        dtachSocket: "/Users/jeff/.local/share/cbg/state/dtach-calmLion.sock",
        connectedAt: 1728675432000,

        // IPC (not serialized — restored on session_register)
        _conn: UnixConn,

        // Activity
        lastActive: 1728675432000,
        lastStopAt: null,
        nudgedForInbound: false,

        // Note: long task lives in specialData.longTaskByChatId,
        //       not here (big definition strings don't belong in the hot set).
        //       chatSessions.calmLion has a pointer: longTaskId
        longTaskId: "FixAuthMigrationA1b2" | null,
    },
}
```

Use **keyed objects** everywhere, not arrays. Setting a key to
`undefined` in a merge patch DELETES it. This is the `mergeSessionData`
contract (see below).

### 2. `chatState` — global state (hot, in-memory)

```js
{
    focusedSessionId: "calmLion" | null,
    pendingFocusId: "happyFox" | null,

    // Pending OTPs (from onboarding) — RAM-only, no disk backup
    pendingOtps: {
        "a1b2c3d4": { createdAt: 1728675432000, chatId: null },
    },

    // Pending permission requests (from shim)
    pendingPermissions: {
        "perm-xyz789": {
            sessionId: "calmLion",
            toolName: "Bash",
            description: "run tests",
            createdAt: 1728675432000,
            _conn: UnixConn,  // for ipc_respond
        },
    },

    // Stats
    stats: { eventsProcessed: 0, queueDepth: 0 },
}
```

### 3. `specialData` — data that's expensive to rebuild or too large for chatSessions

Keyed by chat id (Telegram chat). Written to disk eagerly on change
(not on every event — only when `specialData` changes). Loaded on
startup.

```js
{
    // Long tasks by chat, by task id
    longTaskByChatId: {
        "688903965": {
            FixAuthMigrationA1b2: {
                id: "FixAuthMigrationA1b2",
                title: "Fix auth migration",
                originalPrompt: "fix the auth migration so all tests pass",
                createdAt: "2026-04-12T05:36:00Z",
                state: "in_progress",
                workerSessionId: "calmLion",

                // The big field — definition of done (markdown, possibly large)
                definition: "## Definition\n- All tests pass\n- ...",

                // Nudge state
                consecutiveIdleStops: 0,
                totalNudges: 3,
                lastNudgeAt: "2026-04-12T06:10:00Z",

                // Critic state
                criticCallCount: 2,
                criticLastCallAt: "2026-04-12T06:05:00Z",
                criticIndecisiveRetries: 0,
            },
        },
    },

    // Last 5 non-hook Telegram messages per chat (rolling window)
    telegramMessagesByChatId: {
        "688903965": [
            { from: "user",  ts: 1728675000000, messageId: 4820, text: "hi" },
            { from: "agent", ts: 1728675005000, text: "hello!" },
            // ... up to 5 entries
        ],
    },
}
```

**On task completion (`certified` or `cancelled`):**
`delete specialData.longTaskByChatId[chatId][taskId]`. The task is
removed from the hot set. Its history lives in cold storage.

### State files on disk

```
~/.local/share/cbg/state/
    chatState.json           # blind dump of chatState (minus pendingPermissions with _conn)
    chatSessions.json        # blind dump of chatSessions (minus _conn)
    specialData.json         # written on every specialData change
    cbg.version              # current globalThis.cbgVersion (for shims to read)
    cold-storage/            # append-only archival logs (see below)
        messages.jsonl
        long-tasks.jsonl
        hooks.jsonl
```

### Restart/reload flow

1. **Shutdown (reload or SIGTERM):** write `chatState.json`,
   `chatSessions.json` to disk.
2. **Startup:**
   - Load `chatState.json`, `chatSessions.json`, `specialData.json`.
   - `chatSessions[*]._conn` is absent — sessions are "disconnected"
     until they re-register.
   - For each chat id in `chatSessions` (derived from recent
     `specialData.telegramMessagesByChatId` keys), load the last 5
     messages from cold storage if not already in `specialData`.
3. **Shim reconnection:** as shims re-register via IPC, the
   `session_register` handler merges `_conn` into the existing
   `chatSessions[sid]` entry WITHOUT touching anything else.

---

## Cold storage

Cold storage is the **append-only archival log**. It's the source of
truth for history queries. It is NOT read on every event — only when
explicitly queried (debugging, `/task_history`, etc.).

Three streams (all JSONL):

### `cold-storage/messages.jsonl`

Every Telegram message in either direction:
```jsonc
{
    "ts": 1728675432000,
    "from": "user" | "agent",
    "chatId": "688903965",
    "userId": "688903965" | null,
    "messageId": 4821 | null,
    "sessionId": "calmLion" | null,
    "text": "...",
    "attachment": null | { "fileId": "...", "kind": "photo" }
}
```

On startup, the last 5 entries per chat id are pulled into
`specialData.telegramMessagesByChatId`.

### `cold-storage/long-tasks.jsonl`

Every long-task state transition:
```jsonc
{
    "ts": 1728675432000,
    "taskId": "FixAuthMigrationA1b2",
    "chatId": "688903965",
    "event": "created" | "definition_locked" | "state_change" | "nudged"
           | "critic_call" | "critic_verdict" | "completed" | "cancelled",
    "fromState": "defining" | null,
    "toState": "in_progress" | null,
    "details": { ... }
}
```

Used for `/task_history <id>` queries and post-mortem debugging. When
a task completes and is removed from `specialData.longTaskByChatId`,
its history remains queryable via this log.

### `cold-storage/hooks.jsonl`

Optional archival of hook events for debugging (noisy — off by default,
enable with `cbg config hooks.archive true`).

### Cold storage helper API (`lib/cold-storage.js`)

```js
// Append (cheap, writeTextFileSync with { append: true })
export function appendColdMessage(entry)
export function appendColdLongTaskEvent(entry)
export function appendColdHookEvent(entry)

// Query (expensive, reads the file; use sparingly)
export function tailColdMessages({ chatId, limit })
export function tailColdLongTasks({ taskId, limit })
export function findColdLongTaskHistory(taskId)
```

Cold storage appends are side effects. Handlers emit
`{ type: "cold_append", stream: "messages", entry: {...} }` effects.

---

## IPC is the only transport

There is no HTTP server. Every external input that isn't Telegram or a
Claude hook goes through the single Unix-socket IPC listener at
`~/.local/share/cbg/state/ipc.sock`.

Three kinds of clients connect to IPC:

1. **Shims** — the MCP server instance inside each Claude Code session.
   Long-lived. First message is `{ type: "register", session: {...} }`.
2. **Hook scripts** — one-shot connection per hook event. Sends a
   `hook_event` message, closes.
3. **CLI clients** — one-shot connection for `cbg reload`, `cbg
   onboard`, etc. Sends a `cli_command` message with `{ kind, payload }`,
   awaits a reply, closes.

The server distinguishes them by the first message's `type` field. Shim
connections stay in `core.ipcConns` (indexed by session id after
register). Hook and CLI connections are one-shot — reply and close.

### CLI → IPC client helper

```js
// lib/ipc-client.js (reloadable; used by CLI subcommands)
import { IPC_SOCK } from "./protocol.js"

export async function sendCliCommand(kind, payload, { timeoutMs = 5000 } = {}) {
    const conn = await Deno.connect({ transport: "unix", path: IPC_SOCK })
    try {
        const request = JSON.stringify({ type: "cli_command", kind, payload }) + "\n"
        await conn.write(new TextEncoder().encode(request))

        // Read one line of reply
        const buf = new Uint8Array(8192)
        let pending = ""
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
            const n = await Promise.race([
                conn.read(buf),
                new Promise(r => setTimeout(() => r(null), deadline - Date.now())),
            ])
            if (n == null) { break }
            pending += new TextDecoder().decode(buf.subarray(0, n))
            const nl = pending.indexOf("\n")
            if (nl >= 0) {
                return JSON.parse(pending.slice(0, nl))
            }
        }
        throw new Error("timeout waiting for IPC reply")
    } finally {
        try { conn.close() } catch (e) { dbg("IPC-CLIENT", "close:", e) }
    }
}
```

### OTP via IPC (no more disk writes for onboarding)

Old flow: `cbg onboard` writes `pending_otp.json` to STATE_DIR, server
polls it. Gross.

New flow:
1. `cbg onboard` CLI generates a random OTP.
2. CLI calls `sendCliCommand("set_pending_otp", { otp })`.
3. Server enqueues a `cli_command` event with kind=`set_pending_otp`.
4. Handler stores it in `chatState.pendingOtps[otp]`, emits an
   `ipc_respond` effect with `{ ok: true }`.
5. CLI shows the user the command to send to the bot:
   `/approve_user one_time_password:<otp>`.
6. User sends the command on Telegram.
7. Telegram handler validates against `chatState.pendingOtps[otp]`,
   clears on success.

No disk write, no polling. If the daemon isn't running, `Deno.connect`
fails and the CLI tells the user to start it first.

### `cbg reload` via IPC

Same pattern: `sendCliCommand("reload_cbg", {})` → server handler
bumps `globalThis.cbgVersion`, writes to `cbg.version` file, replies
with the new version. CLI prints it.

### Worker submits long-task definition via shim MCP tool

Workers (Claude Code sessions) cannot open arbitrary sockets cleanly.
They already have an MCP shim exposing tools to the Claude runtime. We
add a new tool:

```js
{
    name: "submit_long_task_definition",
    description: "Submit the definition of done for your current long task. Fails if you don't have an active task or if the definition has already been submitted.",
    inputSchema: {
        type: "object",
        required: ["taskId", "definition"],
        properties: {
            taskId: { type: "string" },
            definition: { type: "string", description: "Markdown definition of done" }
        }
    }
}
```

The shim's tool handler forwards via its existing IPC connection as an
IPC message `{ type: "long_task_definition_submitted", sessionId,
taskId, definition, requestId }`. The server enqueues a
`long_task_definition_submitted` event and responds via
`ipc_respond` with the result routed back through the shim as a
`tool_response`.

Workers invoke this from Claude directly — no `curl`, no knowledge of
sockets or ports. Error cases (task not found, wrong state, duplicate
submission) come back as structured MCP errors, not HTTP status codes.

### MCP tool registration constraint

Claude Code queries the shim for its tool list **once at MCP server
startup**. Tool names and schemas are frozen for that session's
lifetime. Tool *handlers* can be hot-swapped mid-session via dynamic
imports (that's how shim reloadability works), but the *set* of
tool names cannot.

**Implication:** adding a new tool to the shim requires running
sessions to be restarted before they can use it. We accept this as a
Claude Code MCP limitation for v1.

**Practical rule:** register all known tools upfront in the shim.
Today that's:
- `reply`, `react`, `edit_message`, `download_attachment`, `set_title`,
  `new_command`, `reload` (existing)
- `submit_long_task_definition` (new, for the long-task flow)
- `cbg_debug` (new, for the server dump + log path)

Any future tool additions will require a session restart to take
effect. If the need becomes frequent, we can add a generic
`cbg_server_message` escape-hatch tool later, but for v1 we keep it
explicit.

---

## `mergeSessionData` semantics

Handlers return partial state patches. `onEvent` applies them via
`mergeSessionData` (or `mergeState`):

```js
// lib/state-merge.js
export function mergeSessionData(target, patch) {
    if (patch === null || patch === undefined) {
        return undefined  // caller should delete the key
    }
    if (typeof patch !== "object" || Array.isArray(patch)) {
        return patch      // scalars and arrays replace wholesale
    }
    // Object: recursive merge
    const out = { ...target }
    for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) {
            delete out[key]
        } else {
            out[key] = mergeSessionData(out[key], value)
        }
    }
    return out
}
```

Rules:
- **Objects merge recursively.** Other keys are preserved.
- **`undefined` deletes the key.** `{ longTaskId: undefined }` removes it.
- **Arrays replace wholesale.** Use keyed objects instead of arrays
  whenever possible. If you must use an array, you're replacing the
  whole thing.
- **Scalars replace.** `{ state: "in_progress" }` overwrites the old state.

`onEvent` applies the merge:

```js
async function applyAction(action, core) {
    // 1. Merge state patches
    if (action.stateChanges?.chatState) {
        core.chatState = mergeSessionData(core.chatState, action.stateChanges.chatState)
    }
    if (action.stateChanges?.chatSessions) {
        core.chatSessions = mergeSessionData(core.chatSessions, action.stateChanges.chatSessions)
    }
    if (action.stateChanges?.specialData) {
        core.specialData = mergeSessionData(core.specialData, action.stateChanges.specialData)
        // specialData is written on every change (debounced)
        schedulePersist("specialData")
    }

    // 2. Run effects
    for (const effect of action.effects ?? []) {
        const { applyEffect } = await import(`./tooling/apply-effect.js?v=${globalThis.cbgVersion}`)
        await applyEffect(effect, core)
    }

    // 3. Enqueue follow-ups
    for (const ev of action.followUpEvents ?? []) {
        core.enqueueEvent(ev)
    }
}
```

Note: `persist_long_task` as a separate effect is GONE. Long tasks live
in `specialData.longTaskByChatId`, and any change to `specialData`
auto-triggers a debounced disk write. Handlers just emit state changes.

---

## Event type schemas

Each event has `type` (discriminator) and `ts` (enqueue time). Full
schemas per type. The source that enqueues is in parentheses.

### `telegram_user_message` (Grammy bot)

```jsonc
{
    "type": "telegram_user_message",
    "ts": 1728675432000,
    "chatId": "688903965",
    "userId": "688903965",
    "username": "jeffhykin",
    "messageId": 4821,
    "text": "/task fix the auth migration",
    "replyToMessageId": null,
    "attachment": null,
    "chatType": "private"
}
```

### `telegram_callback_query` (Grammy bot — inline button press)

```jsonc
{
    "type": "telegram_callback_query",
    "ts": 1728675432000,
    "chatId": "688903965",
    "userId": "688903965",
    "queryId": "cbq-xyz",
    "data": "perm:allow:perm-xyz789"
}
```

### `claude_channel_tool_request` (IPC — shim sent a tool_request)

Claude called an MCP tool exposed by the telegram plugin (reply, react,
edit_message, download_attachment, etc.).

```jsonc
{
    "type": "claude_channel_tool_request",
    "ts": 1728675432000,
    "sessionId": "calmLion",
    "requestId": "req-abc123",
    "toolName": "reply",
    "args": {
        "text": "hello user",
        "chat_id": "688903965",
        "reply_to": "4821",
        "files": ["/tmp/foo.png"]
    },
    "_conn": "<UnixConn>"
}
```

### `claude_hook_stop` (IPC — hook.js → server)

```jsonc
{
    "type": "claude_hook_stop",
    "ts": 1728675432000,
    "sessionId": "calmLion",
    "claudePid": 48291,
    "claudeSessionUuid": "3f2a..."
}
```

PID resolution happens at enqueue time in the IPC listener.

### `claude_hook_pre_tool_use` (IPC — hook.js → server)

```jsonc
{
    "type": "claude_hook_pre_tool_use",
    "ts": 1728675432000,
    "sessionId": "calmLion",
    "claudePid": 48291,
    "toolName": "Bash",
    "inputPreview": "{\"command\":\"ls\",\"description\":\"list\"}",
    "isError": false
}
```

Low-signal, high-volume. First to be purged under back-pressure.

### `claude_hook_post_tool_use` (IPC — hook.js → server)

```jsonc
{
    "type": "claude_hook_post_tool_use",
    "ts": 1728675432000,
    "sessionId": "calmLion",
    "claudePid": 48291,
    "toolName": "Bash",
    "inputPreview": "{\"command\":\"ls\"}",
    "outputPreview": "{\"stdout\":\"file1\\nfile2\"}",
    "isError": false
}
```

Same — purged first under back-pressure.

### `session_register` (IPC — shim sent `register`)

```jsonc
{
    "type": "session_register",
    "ts": 1728675432000,
    "session": {
        "id": "calmLion",
        "pid": 48291,
        "cwd": "/Users/jeff/repos/x",
        "title": null,
        "gitBranch": "master",
        "dtachSocket": "/Users/jeff/.local/share/cbg/state/dtach-calmLion.sock",
        "connectedAt": 1728675432000,
        "inDtach": true
    },
    "_conn": "<UnixConn>"
}
```

### `session_unregister` (IPC — shim sent `unregister` or connection closed)

```jsonc
{
    "type": "session_unregister",
    "ts": 1728675432000,
    "sessionId": "calmLion",
    "reason": "clean" | "crash" | "ipc_error"
}
```

### `permission_request` (IPC — shim sent `permission_request`)

```jsonc
{
    "type": "permission_request",
    "ts": 1728675432000,
    "sessionId": "calmLion",
    "requestId": "perm-xyz789",
    "toolName": "Bash",
    "description": "run tests",
    "inputPreview": "{\"command\":\"npm test\"}",
    "_conn": "<UnixConn>"
}
```

### `permission_response` (enqueued from `telegram_callback_query` handler)

Not a source event — produced by the handler that parses the callback
query data. Listed here because it's a distinct onEvent dispatch.

```jsonc
{
    "type": "permission_response",
    "ts": 1728675432000,
    "requestId": "perm-xyz789",
    "decision": "allow" | "deny" | "allow_once" | "allow_session",
    "responderChatId": "688903965",
    "responderUserId": "688903965"
}
```

### `cli_command` (IPC — CLI client sent a one-shot message)

All CLI client submissions come through this single event type. The
handler dispatches by `kind`.

```jsonc
{
    "type": "cli_command",
    "ts": 1728675432000,
    "kind": "set_pending_otp" | "reload_cbg" | "server_dump" | "shutdown" | "...",
    "payload": { /* kind-specific */ },
    "_conn": "<UnixConn>"
}
```

The handler sends a one-line JSON reply via `ipc_respond` effect and
the shell closes the connection.

Known `kind`s and their payloads:

| `kind`             | `payload`                                      | Reply                               |
|--------------------|------------------------------------------------|-------------------------------------|
| `set_pending_otp`  | `{ otp: "a1b2c3d4" }`                          | `{ ok: true }`                      |
| `reload_cbg`       | `{}`                                           | `{ ok: true, version: 7 }`          |
| `server_dump`      | `{ targetPath?: "/tmp/cbg-dump.json" }`        | `{ ok: true, dumpPath: "..." }`     |
| `shutdown`         | `{}`                                           | `{ ok: true }`                      |
| `get_cbg_version`  | `{}`                                           | `{ ok: true, version: 7 }`          |

### `long_task_definition_submitted` (IPC — from a shim MCP tool call)

Fired when a worker called `submit_long_task_definition` via its
shim's MCP handler, which forwarded an IPC message of the same type.

```jsonc
{
    "type": "long_task_definition_submitted",
    "ts": 1728675432000,
    "sessionId": "calmLion",
    "requestId": "req-abc123",
    "taskId": "FixAuthMigrationA1b2",
    "definition": "## Definition\n- All tests pass",
    "_conn": "<UnixConn>"
}
```

Handler validates (task exists, session matches, state is `defining`,
no definition already stored), stores in
`specialData.longTaskByChatId`, responds to the shim via
`ipc_respond` so the MCP tool returns cleanly to Claude.

### `ipc_connection_closed` (shell — connection ended)

```jsonc
{
    "type": "ipc_connection_closed",
    "ts": 1728675432000,
    "_conn": "<UnixConn>"
}
```

Handler looks up which session (if any) was registered on this conn
and enqueues a `session_unregister` follow-up event.

### `session_timer` (timer manager)

```jsonc
{
    "type": "session_timer",
    "ts": 1728675432000,
    "sessionId": "calmLion",
    "timerName": "idle_fallback",
    "scheduledAt": 1728675132000
}
```

Handlers never `setTimeout` directly. They emit `set_session_timer`
effects. The timer tooling calls `setTimeout`, which enqueues a
`session_timer` event when fired.

### `critic_verdict` (critic subprocess completion)

```jsonc
{
    "type": "critic_verdict",
    "ts": 1728675432000,
    "taskId": "FixAuthMigrationA1b2",
    "sessionId": "calmLion",
    "chatId": "688903965",
    "verdict": "certified" | "revisions" | "anomaly" | "indecisive"
             | "clarification_needed" | "error",
    "criticStdout": "...",
    "elapsedMs": 8203,
    "attempt": 1
}
```

### `server_dump` (Telegram admin command or shim MCP tool)

A server_dump can be requested from either Telegram (admin command
`/server_dump`) or from a Claude session via the shim's `cbg_debug`
MCP tool. Both paths enqueue this event — the `source` distinguishes
them for reply routing.

```jsonc
{
    "type": "server_dump",
    "ts": 1728675432000,
    "source": "telegram" | "mcp_tool",
    "chatId": "688903965" | null,      // set when source=telegram
    "_conn": "<UnixConn>" | null,      // set when source=mcp_tool (for ipc_respond)
    "requestId": "req-def456" | null   // set when source=mcp_tool
}
```

Handler writes the dump file and emits either a `send_file_to_user`
effect (Telegram case) or an `ipc_respond` effect (MCP case).

Note: CLI-triggered dumps go through `cli_command` with
`kind="server_dump"` instead; this event is for Telegram and MCP
sources.

---

## Side effect types

```jsonc
// Telegram outbound
{ "type": "send_text_to_user", "chatId": "...", "text": "...", "options": { "parse_mode": "HTML" } }
{ "type": "send_file_to_user", "chatId": "...", "filePath": "/tmp/x.md", "filename": "def.md", "caption": null }
{ "type": "send_reaction",     "chatId": "...", "messageId": "4821", "emoji": "👀" }
{ "type": "edit_telegram_message", "chatId": "...", "messageId": "4821", "text": "...", "options": {} }

// Claude sessions (dtach)
{ "type": "send_text_to_claude", "sessionId": "calmLion", "text": "..." }
{ "type": "send_files_to_claude", "sessionId": "calmLion", "filePaths": ["/tmp/x.png"] }

// Session lifecycle
{ "type": "create_headless_chat", "name": "critic-chat", "replyEventType": "chat_created" }
{ "type": "close_chat", "sessionId": "calmLion" }

// Timers
{ "type": "set_session_timer", "sessionId": "calmLion", "timerName": "idle_fallback", "delayMs": 600000 }
{ "type": "clear_session_timer", "sessionId": "calmLion", "timerName": "idle_fallback" }

// Subprocess spawns
{ "type": "spawn_critic", "taskId": "FixAuthMigrationA1b2", "dryRun": false }

// IPC responses
// Used for: shim tool_response routing, cli_command replies, one-shot closures.
// `closeAfter: true` closes the connection after sending (CLI one-shot pattern).
{ "type": "ipc_respond", "conn": "<UnixConn>", "message": { "type": "tool_response", "requestId": "...", "result": {} } }
{ "type": "ipc_respond", "conn": "<UnixConn>", "message": { "ok": true, "version": 7 }, "closeAfter": true }

// Cold storage appends
{ "type": "cold_append", "stream": "messages" | "long-tasks" | "hooks", "entry": {} }

// Debug
{ "type": "write_server_dump", "targetPath": "/tmp/cbg-dump.json" }
```

Note: `persist_long_task` and `persist_chat_state` are GONE. Persistence
is handled automatically:
- `specialData` changes → debounced write to `specialData.json` (within
  500 ms of the change, flush once).
- `chatState` / `chatSessions` → written only on shutdown/reload, NOT
  on every change.

---

## Standard tooling functions

All live in `lib/tooling/`. Called by `applyEffect`. These are the only
places that touch external systems.

```js
// Telegram
sendTextMessageToUser(chatId, text, options)
sendFileToUser(chatId, filePath, filename, caption)
sendReaction(chatId, messageId, emoji)
editTelegramMessage(chatId, messageId, newText, options)

// Claude sessions (dtach)
sendTextToClaude(sessionId, text)        // dtach -p inject
sendFilesToClaude(sessionId, ...filePaths)
readChatStdout(sessionId, { lines })     // reads dtach log as string
readRawChatStdout(sessionId)             // raw bytes

// Session management
async createHeadlessChat(name)            // spawns new session, returns id
async sendChatStdin(sessionId, data)      // same underlying mechanism as sendTextToClaude
async closeChat(sessionId)

// Timers
setSessionTimer(sessionId, timerName, delayMs)
clearSessionTimer(sessionId, timerName)

// Critic
async spawnCriticSubprocess(taskId, dryRun, onComplete)

// IPC outbound
ipcRespond(conn, message, { closeAfter = false } = {})

// Persistence
schedulePersist(which)  // "specialData" | "chatState" | "chatSessions"
flushPersistenceNow()   // used on shutdown

// Cold storage
appendColdEntry(stream, entry)

// Debug
writeServerDump(targetPath)
```

---

## Debugging: `server_dump`

A pure snapshot of the live state, minus non-serializable bits. Used
for:
- Telegram admin command `/server_dump` (reply with a .json file
  attachment)
- MCP debug tool (shim exposes a `server_dump` tool that pulls the
  snapshot + tails the main.log)

Snapshot contents:
```jsonc
{
    "timestamp": "2026-04-12T...",
    "cbgVersion": 7,
    "queueDepth": 3,
    "stats": { "eventsProcessed": 2841 },
    "chatState": { /* minus pendingPermissions._conn */ },
    "chatSessions": { /* minus _conn */ },
    "specialData": { /* full, including definitions */ }
}
```

### MCP debug tool integration

The shim's existing debug output tells Claude where the main log is.
Add: tell it where a fresh `server_dump` is. The shim exposes a
`cbg_debug` MCP tool:

```jsonc
{
    "name": "cbg_debug",
    "description": "Returns the path to the CBG server log and a fresh server state dump",
    "inputSchema": { "type": "object", "properties": {} }
}
```

Implementation: the tool handler sends a `server_dump` event to the
server via IPC, awaits the dump path via the event's `_resolve`,
returns `{ logPath, dumpPath }` to Claude.

---

## Walkthroughs

### Example 1: `/task fix auth migration`

**Event enqueued** (Grammy handler in main-server.js):
```jsonc
{
    "type": "telegram_user_message",
    "ts": 1728675432000,
    "chatId": "688903965",
    "userId": "688903965",
    "messageId": 4821,
    "text": "/task fix auth migration",
    "chatType": "private"
}
```

**`onEvent` dispatches to `handleTelegramUser`** (loaded dynamically):
```js
const { handleTelegramUser } = await import(`./event-handlers/telegram-user.js?v=${globalThis.cbgVersion}`)
const action = await handleTelegramUser(event, core)
```

**Handler logic** (pure):
1. Access check passes.
2. Regex matches `/task` → dispatches to `handleTaskCommand`.
3. Reads `core.chatState.focusedSessionId` = `"calmLion"`.
4. Reads `core.chatSessions.calmLion`. Checks `longTaskId` is null.
5. Generates task id `FixAuthMigrationA1b2`.
6. Returns:
```jsonc
{
    "stateChanges": {
        "chatSessions": {
            "calmLion": { "longTaskId": "FixAuthMigrationA1b2" }
        },
        "specialData": {
            "longTaskByChatId": {
                "688903965": {
                    "FixAuthMigrationA1b2": {
                        "id": "FixAuthMigrationA1b2",
                        "title": "fix auth migration",
                        "state": "defining",
                        "workerSessionId": "calmLion",
                        "definition": null,
                        "consecutiveIdleStops": 0,
                        "totalNudges": 0
                        /* ... */
                    }
                }
            }
        }
    },
    "effects": [
        { "type": "send_text_to_user", "chatId": "688675432", "text": "Task started.\n/task_status_..." },
        { "type": "send_text_to_claude", "sessionId": "calmLion", "text": "..." },
        { "type": "cold_append", "stream": "long-tasks", "entry": { "event": "created", ... } }
    ]
}
```

**`onEvent` applies:**
1. Deep-merges state changes (keyed — no replacement, only merge).
2. Schedules `specialData.json` write (debounced 500ms).
3. Runs effects: sends Telegram reply, injects prompt via dtach, appends
   cold log.

### Example 2: Worker submits definition via MCP tool

**Worker's side** (inside Claude): calls the MCP tool
`submit_long_task_definition` with `{ taskId: "FixAuthMigrationA1b2",
definition: "## Definition\n- All tests pass" }`.

**Shim side**: the tool handler forwards via its IPC connection:
```json
{
    "type": "long_task_definition_submitted",
    "sessionId": "calmLion",
    "requestId": "req-def456",
    "taskId": "FixAuthMigrationA1b2",
    "definition": "## Definition\n- All tests pass"
}
```

**Shell's IPC translator** produces an event:
```jsonc
{
    "type": "long_task_definition_submitted",
    "ts": 1728675432000,
    "sessionId": "calmLion",
    "requestId": "req-def456",
    "taskId": "FixAuthMigrationA1b2",
    "definition": "## Definition\n- All tests pass",
    "_conn": "<UnixConn>"
}
```

**Handler** (`handleLongTaskDefinitionSubmitted`):
1. Finds task: iterates `core.specialData.longTaskByChatId` to find
   `FixAuthMigrationA1b2`.
2. Validates: task exists, `state === "defining"`, session matches,
   definition not already stored.
3. Returns:
```jsonc
{
    "stateChanges": {
        "specialData": {
            "longTaskByChatId": {
                "688903965": {
                    "FixAuthMigrationA1b2": {
                        "state": "in_progress",
                        "definition": "## Definition\n- All tests pass"
                    }
                }
            }
        }
    },
    "effects": [
        {
            "type": "ipc_respond",
            "conn": "<UnixConn>",
            "message": {
                "type": "tool_response",
                "requestId": "req-def456",
                "result": { "content": [{ "type": "text", "text": "Definition received. Begin work." }] }
            }
        },
        { "type": "cold_append", "stream": "long-tasks", "entry": { "event": "definition_locked" } }
    ]
}
```

The shim's pending `CallToolRequestSchema` handler resolves, Claude
sees the tool response, and moves on to begin the work.

### Example 3: Stop hook with active long task, nudge threshold reached

**Event enqueued** (IPC listener, after PID → sessionId resolution):
```jsonc
{ "type": "claude_hook_stop", "sessionId": "calmLion", "claudePid": 48291 }
```

**Handler** (`handleStopHook`):
1. Reads `core.chatSessions.calmLion.longTaskId` → `"FixAuthMigrationA1b2"`.
2. Reads task from `core.specialData.longTaskByChatId[<chatId>][taskId]`.
   (Chat id is derived by iterating keys — or we keep it on the session.)
3. `state === "in_progress"`, `consecutiveIdleStops` about to become 2.
4. Threshold reached. Checks for `report.md` in task dir — does not exist.
5. Returns:
```jsonc
{
    "stateChanges": {
        "chatSessions": { "calmLion": { "lastStopAt": 1728675432000 } },
        "specialData": {
            "longTaskByChatId": {
                "688903965": {
                    "FixAuthMigrationA1b2": {
                        "state": "awaiting_report",
                        "totalNudges": 4,
                        "consecutiveIdleStops": 0,
                        "lastNudgeAt": "2026-04-12T..."
                    }
                }
            }
        }
    },
    "effects": [
        { "type": "send_text_to_claude", "sessionId": "calmLion", "text": "[long task ...] write report.md if done" },
        { "type": "cold_append", "stream": "long-tasks", "entry": { "event": "nudged", "totalNudges": 4 } }
    ]
}
```

### Example 4: Task completion (cold transition)

When a critic verdict is `certified`:

**Handler** (`handleCriticVerdict`):
1. Reads task from specialData.
2. Returns:
```jsonc
{
    "stateChanges": {
        "specialData": {
            "longTaskByChatId": {
                "688903965": {
                    "FixAuthMigrationA1b2": undefined
                }
            }
        },
        "chatSessions": {
            "calmLion": { "longTaskId": undefined }
        }
    },
    "effects": [
        { "type": "send_text_to_claude", "sessionId": "calmLion", "text": "[certified] notify user" },
        { "type": "cold_append", "stream": "long-tasks", "entry": { "event": "completed", "finalState": "certified" } }
    ]
}
```

`undefined` deletes the key. The task is purged from hot memory. Its
history stays in `cold-storage/long-tasks.jsonl` and its files stay
on disk.

---

## Migration plan

### Phase 0: Understand current mutations

Build a ledger of every place current code mutates `sessions`,
`focusedSessionId`, etc. This is the to-do list for the refactor.

### Phase 1: Shell + event loop (non-breaking)

- Create `main-server.js` (rename of `standalone-server.js`).
- Add the event queue, `enqueueEvent`, `eventLoop`, back-pressure logic.
- Add `core` kernel.
- Wire to load `onEvent` dynamically with version salting.
- Start the event loop. Stub `onEvent` just logs events.
- Verify no regressions.

### Phase 2: State restructuring

- Define `chatState`, `chatSessions`, `specialData` as top-level `let`.
- Write `mergeSessionData`.
- On shutdown: blind-dump `chatState` and `chatSessions`.
- On startup: load them, minus non-serializable fields.
- Keep existing handlers running in parallel, migrated to read from the
  new state objects.

### Phase 3: Cold storage

- Create `lib/cold-storage.js` with `appendColdMessage`, etc.
- Move message logging from the current `logMessage` to cold storage
  appends.
- Populate `specialData.telegramMessagesByChatId` on startup by tailing
  the cold log.

### Phase 4: Migrate event types (one at a time)

Order:
1. **IPC translator scaffolding** — `lib/ipc-translator.js`. Called by
   the shell for every IPC message, returns 0+ events. Initially passes
   through only the messages we've migrated; other messages fall
   through to the legacy handler.
2. `cli_command` handler skeleton + `lib/ipc-client.js` — dispatches
   by `kind`. Unblocks the CLI-side migration.
3. `cli_command` with `kind=set_pending_otp` — replaces disk-based OTP.
   Update `cbg onboard` to use `sendCliCommand`.
4. `cli_command` with `kind=reload_cbg` — enables the reload feature.
   Update `cbg reload` (new subcommand) to use `sendCliCommand`.
5. `cli_command` with `kind=server_dump` — debugging, useful early.
6. **Telegram translator scaffolding** — `lib/telegram-translator.js`.
   Same pattern: Grammy callback calls translator, returns events.
7. `server_dump` event (Telegram admin command path) — the other entry
   point for dumps.
8. `critic_verdict` — wraps the critic spawn (already implemented in the
   non-event-loop version; migrate to event form).
9. `session_timer` — replaces setInterval sprawl.
10. `claude_hook_stop` — wraps current Stop-hook branch in `handleHookEvent`.
11. `claude_hook_pre_tool_use` / `claude_hook_post_tool_use` — current
    hook formatting path.
12. `session_register` / `session_unregister` / `ipc_connection_closed`.
13. `long_task_definition_submitted` — add the new MCP tool to the
    shim; wire the handler.
14. `claude_channel_tool_request` — the big one. Touches Grammy, IPC,
    and dtach. Covers `reply`, `react`, `edit_message`, `download_attachment`,
    `set_title`, `new_command`, `reload` MCP tools.
15. `telegram_user_message` — replaces Grammy handlers.
16. `telegram_callback_query` / `permission_request` / `permission_response`.

Each migration: build handler, wire source to `enqueueEvent` via the
translator, disable old path, test, delete old path.

### Phase 5: Directory reshuffle

Move to `event_generators/` layout. Symlinks for entry points
(`shim.js`, `mod.js`) to preserve existing install paths.

### Phase 6: Shim reloadability

Update `shim.js` to use dynamic imports for its tool handlers. Test
that a live session survives a `cbg reload`.

### Phase 7: Delete old scaffolding

- Remove `lib/message-tracker.js` (state is in `chatSessions`).
- Remove `lib/idle-detector.js` (logic is in Stop hook handler + timer events).
- Remove `maybeNudge`, `runCriticFlow`, any remaining setIntervals.
- Keep `lib/hooks.js` formatters (pure, still useful).

### Phase 8: Stability shakedown

- Load test: thousands of events.
- Race test: simultaneous Telegram messages + shim IPC traffic + CLI commands.
- Reload test: rapid reloads mid-session.
- Crash test: handler throws, loop continues.

---

## Design decisions (previously "Open Questions")

**1. Deep merge semantics for state patches.** Decided: `mergeSessionData`
recursively merges objects, replaces scalars and arrays, and treats
`undefined` as "delete the key." Use keyed objects instead of arrays
inside `chatSessions` / `chatState` / `specialData` wherever possible.

**2. `/server_dump` command.** Included. Also exposed via an MCP debug
tool on the shim (`cbg_debug`) that returns `{ logPath, dumpPath }`.

**3. Persistence frequency.** Decided: different strategies per object.
- `chatState`, `chatSessions`: written on shutdown/reload only. Reload
  survival, not source of truth.
- `specialData`: written on every change, debounced 500ms. This is
  where long task state and recent messages live.
- Cold storage: append-only, written on each event.
- Long task data is removed from `specialData` on completion; history
  lives in cold storage.

**4. Back-pressure.** Decided: hard cap at 128 (configurable via
`config.eventQueueMax`). On overflow: log + alert, purge
`claude_hook_pre_tool_use` and `claude_hook_post_tool_use` events
(low-signal, high-volume), then if still full, drop new events and
alert loudly.

**5. Event ordering.** Pure FIFO. Simple. Handlers MUST react within
`HANDLER_WARN_MS` (default 20s, configurable). Handlers that need to
wait for external state change MUST enqueue a follow-up `session_timer`
or similar, NOT `await` inline. Warn log on slow handlers.

**6. Testing handlers in isolation.** Enabled — handlers are pure. Tests
construct synthetic `core` objects, call the handler, assert on the
returned Action. No integration setup needed for unit tests.
