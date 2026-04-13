# Architecture

This is a Telegram channel plugin for Claude Code, implemented as a Deno project using plain JavaScript. It uses an **event-loop daemon + thin MCP shim** architecture and ships a CLI tool called `cbg`.

## Runtime

**Deno** — no npm/node required. All external dependencies are pinned esm.sh URL imports consolidated in `imports.js`.

## Formatting

- 4-space indentation
- No semicolons
- All `if`/`for` bodies use braces
- Prefer `for...of` and `for...in` over C-style `for`
- Never silently swallow errors. `catch { /* ignore */ }` and `.catch(() => {})` are unacceptable — always log via `dbg()` so failures are diagnosable. Use `catch (e) { dbg("LABEL", "what failed:", e) }` instead.
- All Telegram messages use `parse_mode: "HTML"`, never Markdown or MarkdownV2. Use `<i>`, `<b>`, `<code>`, `<pre>` for formatting. Escape user content with `&amp;`, `&lt;`, `&gt;`. Telegram's Markdown parser is unreliable with mixed formatting.

## Entry Points

- **`event-generators/cli/cli.js`** — CLI entry point (`cbg`). Subcommands: onboard, start, stop, restart, new, resume, status, config.
- **`event-generators/mcp-server/mcp-shim.js`** — Thin MCP proxy that Claude Code loads, one instance per Claude session. Declares the MCP tool list, maintains a long-lived IPC connection to `main-server.js`, and delegates every tool call to `mcp-shim-tool-handler.js` (reloadable via `versionedImport`). Auto-loaded from `.mcp.json`. Named `mcp-shim.js` to disambiguate from the CLAUDE CLI shim at `event-generators/cli/shim-setup.js`.
- **`event-generators/hooks/hook.js`** (via `run-hook` bash wrapper) — Claude Code hooks (`PreToolUse`, `PostToolUse`, `Stop`) run this per-event as one-shot scripts; it forwards the hook payload to `main-server.js` over IPC.
- **`main-server.js`** — Long-lived daemon that owns the Telegram bot, the event queue, and the central state. Thin shell: its ONLY job is to receive events (from shims, hooks, CLI clients, and Grammy) and pump them through `onEvent`. All business logic lives in `lib/` and is loaded via dynamic `versionedImport`, so the daemon can hot-reload without dropping any shim connections.

## Event-loop architecture

`main-server.js` is a ~280-line shell. Every external stimulus becomes an **event** enqueued into a single FIFO queue, and `onEvent(event, core)` drains the queue serialized. This makes state mutations centralized and reasoning tractable.

### Event sources → event types

| Source | Event type |
|---|---|
| Grammy `message:text` (via `TelegramBot`) | `chat_user_message` |
| Grammy `message:photo` / `:document` / `:voice` / `:audio` / `:video` / `:video_note` / `:sticker` | `chat_user_message` with `attachment` populated |
| Grammy `callback_query:data` | `telegram_callback_query` |
| Discord `MESSAGE_CREATE` (via `DiscordBot`) | `chat_user_message` |
| Shim IPC `register` | `session_register` |
| Shim IPC `unregister` or read-loop EOF | `session_unregister` / `ipc_connection_closed` |
| Shim IPC `tool_request` | `claude_channel_tool_request` |
| Shim IPC `permission_request` | `permission_request` |
| Shim IPC `long_task_definition_submitted` | `long_task_definition_submitted` |
| Hook `hook_event` with hook=Stop / PreToolUse / PostToolUse | `claude_hook_stop` / `claude_hook_pre_tool_use` / `claude_hook_post_tool_use` |
| CLI client IPC `cli_command` | `cli_command` (with `kind`: `set_pending_otp`, `reload_cbg`, `get_cbg_version`, `server_dump`, `shutdown`) |
| Critic subprocess completion (async follow-up) | `critic_verdict` |
| Download tooling follow-up (async) | `download_complete_for_tool` (and a re-enqueued `chat_user_message` with `imagePath`) |
| Telegram admin or MCP debug tool | `server_dump` |

### Handler contract (pure functions)

Handlers in `lib/event-handlers/*.js` are PURE. They receive `(event, core)` and return an **Action**:

```js
{
    stateChanges: {
        chatState: { /* partial patch, merged via mergeSessionData */ },
        chatSessions: { [sid]: { /* partial patch */ } },
        specialData: { longTaskByChatId: { [chatId]: { [taskId]: { /* partial */ } } } },
    },
    effects: [
        { type: "send_text_to_user", chatId, text, options },
        { type: "send_text_to_claude", sessionId, text },
        { type: "deliver_channel_event", sessionId, content, meta },
        { type: "ipc_respond", conn, message, closeAfter },
        { type: "cold_append", stream, entry },
        /* ... */
    ],
    followUpEvents: [ /* optional events to enqueue after this one */ ],
}
```

**Handlers NEVER mutate `event`, `core.chatState`, `core.chatSessions`, or `core.specialData` directly.** They describe intent; `onEvent` applies state merges and runs effects in order.

Bridging concession: the `run_hot_command` effect and `ctx.reply` calls from legacy `commands/*.js` files bypass this contract. Documented in `lib/effects/hot-command-runner.js`.

### Effects (side-effect layer)

All side effects happen in `lib/effects/*.js`. Dispatch is inlined in `lib/main-event-processor.js` as the module-top `effectDispatch` table — each `effect.type` maps to a function imported via `versionedImport` at module load. No separate `apply-effect.js` file; the dispatch table lives alongside the event-dispatch `handlers` table so both sides of the (event handler, effect) pair are edited in one place. Effect modules are the only place in the codebase allowed to do filesystem I/O, Grammy API calls, subprocess spawning, etc.

Effect types currently implemented:
- **Telegram outbound**: `send_text_to_user`, `send_file_to_user`, `send_reaction`, `edit_telegram_message`, `answer_callback_query`
- **Claude sessions (dtach)**: `send_text_to_claude`, `send_files_to_claude`
- **IPC**: `ipc_respond` (reply to shim/CLI over Unix socket)
- **Channel delivery**: `deliver_channel_event` (forward Telegram inbound to a worker's shim)
- **Filesystem**: `write_file`, `bump_cbg_version`
- **Timers**: `set_timer` (fires an arbitrary event at the front of the queue after delay)
- **Persistence**: auto-triggered by `specialData` state changes (debounced)
- **Cold storage**: `cold_append` (append JSONL to messages/long-tasks/hooks streams)
- **Critic**: `spawn_critic` (fires `claude -p` async, enqueues `critic_verdict` when done)
- **Downloads**: `download_telegram_file` (downloads a file_id to INBOX_DIR, enqueues a follow-up)
- **Hot commands**: `run_hot_command`, `reload_hot_commands`

## Hot reload via `versionedImport`

The daemon is fully hot-reloadable. The pattern:

```js
// Every reloadable file starts with this ONE static import:
import { versionedImport } from "./version.js"

// Everything else uses top-level await versionedImport:
const { dbg } = await versionedImport("./logging.js", import.meta)
const { paths } = await versionedImport("./paths.js", import.meta)
const { mergeSessionData } = await versionedImport("./pure/state-merge.js", import.meta)
```

`versionedImport` appends `?v=${globalThis.cbgVersion}` to the import URL. Deno caches modules by URL, so each version is a fresh instance. When `globalThis.cbgVersion` bumps (via `bump_cbg_version` effect), the next `onEvent` call re-imports `./lib/main-event-processor.js` at the new version, which cascades through the whole module graph.

**`lib/version.js` IS the version file** — the `bump_cbg_version` effect rewrites the `VERSION` constant in this file on disk, so a restarted daemon picks up the latest value automatically. There is NO separate `cbg.version` file.

**Custom commands use random salt** (not `cbgVersion`) because they live outside CBG's edit cycle — see `lib/hot-commands.js`.

## Paths: `paths.js` + `buildPaths({ cbgDir, claudeDir })`

CBG's entire filesystem layout is a pure function of TWO roots:

- **`CBG_DIR`** (default: `$HOME/.local/share/cbg`) — everything CBG owns: config, install, state, debug dumps, long-task dirs.
- **`CLAUDE_DIR`** (default: `$HOME/.claude`) — Claude Code's own directory, used only for hook registration (`settings.json`), custom commands, and plugin cache patching.

Both can be overridden via env vars (`CBG_DIR`, `CLAUDE_DIR`).

**Layout under `CBG_DIR`:**
```
$CBG_DIR/
  config.yaml              ← CBG's single config file (was: $HOME/.config/cbg/config.yaml)
  repo/                    ← CBG source checkout (install location)
  state/                   ← runtime state (sockets, pids, logs, json)
    ipc.sock
    server.pid
    main.log
    access.json
    chatState.json, chatSessions.json, specialData.json  (reload survival)
    cold-storage/
      messages.jsonl, long-tasks.jsonl, hooks.jsonl
    long-task-definitions/<taskId>.md
    dtach-<sessionId>.sock / .log
    inbox/                 ← Telegram attachments downloaded here
  long-tasks/              ← on-disk task directories
  debug/<iso-timestamp>.cbg-dump.json
```

**Layout under `CLAUDE_DIR`:**
```
$CLAUDE_DIR/
  settings.json            ← hook registration (CBG patches, Claude owns)
  telegram/custom_commands/<name>.js
  plugins/                 ← plugin cache that event-generators/mcp-server/setup.js self-heals
  scheduled-tasks/         ← user's /cron skill entries
```

**Import pattern (new code):** always use the `paths` object, never the legacy named exports.

```js
const { paths } = await versionedImport("./paths.js", import.meta)
// ...
Deno.readTextFileSync(paths.CONFIG_FILE)
const sockPath = paths.dtachSockFile(sessionId)
const dumpPath = paths.makeDumpPath()  // fresh timestamp every call
```

`paths.js` exports:
- **Scalar path constants**: `CBG_DIR`, `CLAUDE_DIR`, `HOME`, `CONFIG_FILE`, `LOCAL_REPO`, `STATE_DIR`, `DEBUG_DIR`, `LONG_TASKS_DIR`, `ACCESS_FILE`, `IPC_SOCK`, `PID_FILE`, `LOG_FILE`, `MESSAGES_FILE`, `COLD_STORAGE_DIR`, `LONG_TASK_DEFINITIONS_DIR`, `HOOK_PATH`, `MAIN_SERVER_JS`, `MCP_SHIM_JS`, `CLAUDE_SETTINGS`, `CUSTOM_COMMANDS_DIR`, `CLAUDE_PLUGIN_CACHE_DIR`, `CLAUDE_PLUGIN_EXTERNAL_DIR`, `SYSTEMD_SERVICE_FILE`, `LAUNCHD_PLIST_FILE`, etc.
- **Dynamic helpers** (closures over the resolved dirs): `paths.dtachSockFile(sessionId)`, `paths.dtachLogFile(sessionId)`, `paths.shimPidFile(pid)`, `paths.longTaskDir(taskId)`, `paths.longTaskDefinitionBackupFile(taskId)`, `paths.coldStorageStreamFile(stream)`, `paths.persistenceFile(which)`, `paths.makeDumpPath()`.
- **`buildPaths({ cbgDir, claudeDir })`** — the factory, for tests that need a temp root without touching env vars.

## Dependencies

All imports go through `imports.js` which re-exports from pinned esm.sh URLs. No import maps, no deno.json. To bump a version, edit the URL in imports.js.

## Library layout (`lib/`)

### Core event-loop
- **`version.js`** — bootstrap: `versionedImport` + `VERSION` constant. THE only statically-imported file inside `lib/`.
- **`paths.js`** — `buildPaths` factory + pre-built `paths` object (see above).
- **`logging.js`** — `dbg(label, ...args)`. The single most-imported export in the codebase; lives alone because ~40 files need it. (Was part of the old `protocol.js` grab-bag, split out.)
- **`ipc.js`** — `encodeIpcFrame`, `parseIpcMessages`, `UNKNOWN_CLAUDE_PID`. The shared newline-JSON wire format — the one place framing is defined. No `sendIpc` wrapper: each caller inlines `conn.write(encodeIpcFrame(msg))` with the error-handling shape appropriate to its context.
- **`pid.js`** — `findClaudePid`, `findClaudePidStrict`. Ancestry-walk via `ps` used by the hook script to tag events with the originating Claude session's PID.
- **`pure/state-merge.js`** — `mergeSessionData(target, patch)`. Recursive merge with `undefined` = delete, arrays replace wholesale, non-plain objects (UnixConn, etc.) replace by reference, underscore-prefixed keys treated as opaque.
- **`pure/ipc-inbound.js`** — `translateIpcMessage(msg, conn, core)`. Server-side INBOUND dispatch: takes a parsed JSON frame (from `parseIpcMessages`) and returns 0+ events for the main queue. Kept as its own reloadable module so new IPC message types can ship via hot-reload.
- **`main-event-processor.js`** — exports `onEvent`. Loads all handlers AND effect implementations at module-top time via `versionedImport`, builds both dispatch tables (`handlers` keyed by event type, `effectDispatch` keyed by effect type), applies state patches via the file-local `applyStateChanges` helper (wraps `mergeSessionData` + debounced persistence), dispatches effects by table lookup. Used by both the handler's top-level `stateChanges` and the per-effect return-patch pathway, so the two sites can't drift on which slices get persisted or how.

### Handlers (`lib/event-handlers/*.js`)
Pure functions returning Actions. One per event type. All follow the versionedImport pattern.
- `chat-user.js`, `telegram-callback-query.js`
- `claude-channel.js`, `claude-hook-stop.js`, `claude-hook-pre-tool-use.js`, `claude-hook-post-tool-use.js`
- `session-register.js`, `session-unregister.js`, `ipc-connection-closed.js`
- `permission-request.js`
- `cli-command.js`, `server-dump.js`
- `long-task-definition-submitted.js`, `critic-verdict.js`
- `download-complete-for-tool.js`

### Effects (`lib/effects/*.js`)
Side-effect implementations. Counterpart to `lib/event-handlers/`: handlers describe what should happen, these modules actually do it. Dispatch lives in `lib/main-event-processor.js`'s `effectDispatch` table — there is no separate dispatcher file.
- `telegram-outbound.js` — Grammy wrappers: `sendTextMessageToUser`, `sendFileToUser` (with `assertSendable` security guard, 50MB cap, photo-ext detection), `sendReaction`, `editTelegramMessage`, `answerCallbackQuery`, `chunk` helper (4096-char cap)
- `dtach-outbound.js` — `sendTextToClaude` via `dtach -p`; `sendFilesToClaude`
- `ipc-outbound.js` — `ipcRespond` with optional `closeAfter`
- `channel-event.js` — `deliverChannelEvent` (forwards to shim over its live `_conn`)
- `filesystem.js` — `writeFile`, `bumpCbgVersion` (rewrites `lib/version.js`)
- `timers.js` — `setTimer` (push to front of event queue on fire)
- `cold-storage-effect.js` — wraps `appendColdEntry`
- `critic-subprocess.js` — spawns `claude -p` async, enqueues `critic_verdict`
- `telegram-download.js` — downloads Telegram file_id to INBOX_DIR, enqueues follow-up
- `hot-command-runner.js` — `runHotCommand`, `reloadHotCommands`. Bridges legacy `(ctx, bot, state)` commands.
- `persistence.js` — debounced write of `specialData.json` (500 ms), `chatState.json`, `chatSessions.json`

### Pure helpers
- `cold-storage.js` — append/tail helpers for JSONL streams
- `hot-commands.js` — walks `commands/*.js` + `$CUSTOM_COMMANDS_DIR/*.js`, builds the in-memory command registry. Uses random salt (not cbgVersion) for custom commands.
- `hooks.js` — `formatPreToolUse`, `formatPostToolUse` formatters producing HTML for Telegram status messages
- `hook-compact.js` — selects/compacts hook event fields
- `long-task-util.js` — `slugify`, `generateTaskId`
- `pure/html.js` — `escapeHtml`
- `ipc.js` — shared byte-level framing (`encodeIpcFrame`, `parseIpcMessages`, `UNKNOWN_CLAUDE_PID`); the single place the newline-JSON wire format is defined. No `sendIpc` helper — each caller inlines `conn.write(encodeIpcFrame(msg))` with the error-handling shape appropriate to its context.
- `ipc-inbound.js`, `pure/telegram-translator.js` — raw IPC / Grammy → event conversion (dynamically imported per-message, hot-reloadable so new message types ship without a daemon restart)
- CLI ↔ daemon one-shot round-trip (`sendCliCommand`) lives inside `event-generators/cli/helpers.js` alongside the onboard/authorize/reinstall logic that uses it.

### Non-event-loop (still used)
- `config.js` — YAML config at `paths.CONFIG_FILE`. `readConfig`, `writeConfig`, `getConfig(key)`, `setConfig`, `getBotToken`, `getPermissionArgs`.
- `access.js` — `loadAccess`, `gate`, `assertAllowedChat`, pairing, allowlists, group policies
- `daemon.js` — systemd / launchd service management; installs `main-server.js` as a user-level service
- `event-generators/mcp-server/setup.js` — `ensureOfficialPluginPatched` self-heals the official `telegram@claude-plugins-official` plugin's `.mcp.json` files to point at our MCP shim. Lives next to `mcp-shim.js` because both halves (install-time write + shim-bootstrap self-heal) are tightly coupled to the shim it's patching in. Consumed by both `event-generators/cli/helpers.js` (install path) and `event-generators/mcp-server/mcp-shim.js` (runtime drift-heal path).
- `event-generators/cli/shim-setup.js` — claude CLI wrapper installer. NOT the MCP shim — this is the bash script installed at `$PATH/claude` that intercepts the user's `claude` command and adds `--channels` + dtach.
- `dtach.js` — dtach install check, session create/attach/list
- `onboard.js` — full onboarding flow
- `names.js` — `generateName` for session IDs

## Central state

Three top-level objects on `main-server.js`'s `core` kernel. **Only `onEvent` writes to them.**

```js
let chatState = {
    focusedSessionId,
    pendingFocusId,
    pendingOtps,
    pendingPermissions,
    commandErrors,       // for "Ask Claude to fix" button
    messageQueue,        // filled when no focused session
    stats: { eventsProcessed, queueDepth },
}

let chatSessions = {
    [sid]: {
        // from shim register
        id, pid, cwd, title, gitBranch, dtachSocket, connectedAt, inDtach,
        _conn,  // non-serializable; preserved by-reference through mergeSessionData
        // activity tracking
        lastActive, lastStopAt,
        lastInbound: { messageId, chatId, ts, text },
        lastOutboundAt,
        nudgedForInbound,
        // recent messages (for /list formatting)
        recentMessages: [],
    },
}

let specialData = {
    longTaskByChatId: {
        [chatId]: {
            [taskId]: {
                id, title, originalPrompt, createdAt, state,
                workerSessionId, definition,
                consecutiveIdleStops, totalNudges, lastNudgeAt,
                criticCallCount, criticLastCallAt, criticIndecisiveRetries,
            },
        },
    },
    telegramMessagesByChatId: { [chatId]: [{ /* last 5 */ }] },
}
```

`specialData` is persisted eagerly (debounced 500 ms) to `$CBG_DIR/state/specialData.json`. `chatState` and `chatSessions` are blind-dumped on shutdown/reload and restored on startup — NOT sources of truth at runtime, just reload survival.

Cold storage (append-only JSONL) is the source of truth for history queries. When a task terminates, its entry is removed from `specialData.longTaskByChatId` and history lives in cold storage only.

## Hot-reloadable chat commands (`commands/`)

Action-returning contract: `export const commands = { name: async (event, core) => Action }`. Each command file is a pure function from `(event, core)` to an Action of the same shape event handlers return (`stateChanges` / `effects` / `followUpEvents`). No imperative `ctx.reply(...)` or `bot.api.*` — commands describe what should happen, `onEvent` applies it.

Loaded at startup by `lib/hot-commands.js` (walks `commands/*.js` plus `$CUSTOM_COMMANDS_DIR/*.js`). Reloaded via the `reload` MCP tool or whenever `new_command` writes a new file. Dispatched by `lib/event-handlers/chat-user.js` when it sees a `/command` pattern; the command's returned Action is merged into the handler's own Action before the surrounding pipeline runs.

When a command throws, the error is stashed in `chatState.commandErrors[errorId]` and a `🔧 Ask Claude to fix` inline button (abstract `{ buttons: [[{ label, callbackData }]] }` in `SendOptions`) forwards the details to the focused session on click. The legacy `(ctx, bot, state)` bridge + `buildHotCommandState` helper have been removed.

## Skills (`skills/`)

Claude Code slash commands: `/telegram:access`, `/telegram:configure`, `/telegram:logs`.

## MCP tool list (frozen per-session)

Claude Code queries the shim's tool list ONCE at MCP server startup. Tool NAMES cannot change mid-session; tool HANDLERS can hot-reload via `versionedImport`. Current tools:

- **`reply`** — send to a Telegram chat. Auto-chunks at 4096 chars. Auto-detects photo vs document by extension. Refuses files under `STATE_DIR` (except `inbox/`). Max 50MB per file. Supports `format: "html"` (default plain text). Prepends `/chat_<sessionId>\n` header so reply-to routing works.
- **`react`** — emoji reaction
- **`edit_message`** — edit a previously-sent bot message
- **`download_attachment`** — download a file_id to INBOX_DIR
- **`set_title`** — set session title (auto-derives from `cwd` basename + `gitBranch` if empty)
- **`reload`** — hot-reload all commands in `commands/` + `$CUSTOM_COMMANDS_DIR/`
- **`new_command`** — write a new command file and hot-reload
- **`submit_long_task_definition`** — worker submits a long-task definition of done
- **`cbg_debug`** — returns `{ logPath, dumpPath }` for debugging (writes a fresh server_dump)

## Config

Config is stored at `paths.CONFIG_FILE` = `$CBG_DIR/config.yaml`. Managed via `cbg config`. The bot token is read from config (with a legacy fallback to `paths.ENV_FILE`).

```yaml
telegram_bot_token: "123456789:AAH..."
permission_mode: "all"  # or "auto", "acceptEdits", "default", "plan"
```

## Session model

Each Claude Code session runs one MCP shim instance. The shim registers with `main-server.js` over IPC at startup, sending its session ID, PID, cwd, git branch, and dtach socket path. Exactly one session is **focused** — it receives inbound Telegram messages that aren't explicitly routed elsewhere via `/switch_<id>`, `/chat_<id>`, or reply-to-header routing. Outbound `reply` calls from any session always work regardless of focus.

When a user replies to a bot message in Telegram, the bot checks the `reply_to_message.text` for a `/chat_<id>` header (which the `reply` tool auto-prepends) and routes the user's text to THAT session, not the focused one.

Messages sent when no sessions are connected get queued in `chatState.messageQueue` (capped at 50, FIFO drop-oldest) and drained to the next session to become focused.

## Nudge watchdog

When Claude finishes a turn (Stop hook fires) and there's a pending inbound Telegram message older than 45 seconds that hasn't been replied to, the bot injects an `[automated reminder]` into the session's dtach. One nudge per pending inbound (reset when a reply is recorded).

## Long task subsystem

`/task <description>` creates a task under `specialData.longTaskByChatId[chatId][taskId]` in `defining` state and injects a definition-drafting prompt to the focused worker. The worker asks clarifying questions via `reply`, then calls the `submit_long_task_definition` MCP tool to lock the definition. The worker writes `context.md`, `progress.md`, and eventually `report.md` under `$CBG_DIR/long-tasks/<id>/`. When `report.md` appears, the `critic-subprocess` spawns `claude -p` to judge it. The critic's verdict enqueues a `critic_verdict` event which either notifies the worker "certified" (terminal) or archives revisions and tells the worker to try again.

Dynamic commands: `/task_status_<id>`, `/task_view_<id>`, `/task_update_<id>`, `/task_cancel_<id>`.

## Idle detection

Dual-signal:
1. **Stop hook (primary)** — Claude Code fires Stop when the agent finishes a turn. Precise, low-latency. Extended with nudge logic.
2. **Time-based fallback** — a setInterval in `main-server.js` (if needed; currently minimal) tracks `lastStopAt` and falls back to dtach log-size monitoring when the Stop hook hasn't fired in 10+ minutes.

## Skills (`skills/`)

Claude Code slash commands: `/telegram:access`, `/telegram:configure`, `/telegram:logs`.

## `.mcp.json`

Points at `event-generators/mcp-server/mcp-shim.js`. The launch command uses `sh -c` to capture `$PWD` into `SESSION_CWD` before Deno changes the working directory, so sessions report the correct cwd. Built and kept in sync by `event-generators/mcp-server/setup.js`.

## Testing

Unit tests live in `tests/` and run with `deno test tests/ --allow-all`. Pure modules (`state-merge`, `cold-storage`, `telegram-outbound`, `long-task-util`) have direct unit tests. Handlers are testable in isolation by constructing a synthetic `core` object and asserting on the returned Action. Tests that touch paths use the temp-HOME pattern (set `HOME` + `CBG_DIR` + `CLAUDE_DIR` env vars BEFORE dynamically importing the module).

Currently: **61 unit tests passing** (22 state-merge + 12 cold-storage + 13 telegram-outbound + 14 long-task-util).

## What NOT to do

- **Don't add a static `import` from `lib/` inside another `lib/` file.** Use `versionedImport` so the module stays reloadable. The ONE exception is `lib/version.js` itself (the bootstrap).
- **Don't mutate `core.chatState`, `core.chatSessions`, or `core.specialData` directly from a handler.** Return a state patch in the Action.
- **Don't call Grammy APIs, write files, or spawn subprocesses from a handler.** Emit an effect.
- **Don't import `STATE_DIR`, `CONFIG_FILE`, etc. as named exports.** Use `paths.STATE_DIR` / `paths.CONFIG_FILE`. The named exports exist only for legacy compat and may be removed.
- **Don't use `~/.config/cbg/`** for anything — config lives at `$CBG_DIR/config.yaml` now. `~/.config/cbg/config.yaml` is gone.
- **Don't add anything to a `run/` directory** — that pattern is gone. `cbg start` launches `main-server.js` via the daemon service. Shims launch via `.mcp.json`.
- **Don't reference `standalone-server.js` or the top-level `shim.js`** — both deleted. Use `main-server.js` and `event-generators/mcp-server/mcp-shim.js`.
