# Architecture

This is a Telegram channel plugin for Claude Code. It uses a **shim + standalone server** architecture:

## Entry Points

- **`shim.ts`** — Thin MCP proxy that Claude Code loads. One instance per Claude session. Declares tools, proxies all tool calls to the standalone server over a Unix socket (`~/.claude/channels/telegram/ipc.sock`). Auto-starts the standalone server if it isn't running.
- **`standalone-server.ts`** — Long-lived process that owns the Telegram bot. Runs independently of any Claude session. Accepts shim connections via IPC, routes inbound Telegram messages to the focused shim, and executes tool calls on behalf of shims.

## Libraries (`lib/`)

- **`protocol.ts`** — Shared IPC message types, socket helpers, and debug logging used by both shim and server.
- **`telegram-api.ts`** — Telegram Bot API operations (reply, react, edit, download). Used by the standalone server to execute tool calls.
- **`commands.ts`** — Hot-reloadable command loader. Loads `.js` files from `commands/` and `~/.claude/telegram/custom_commands/`.
- **`access.ts`** — Access control: pairing, allowlists, group policies. Reads/writes `~/.claude/channels/telegram/access.json`.
- **`hooks.ts`** — Formats PreToolUse/PostToolUse hook events into Telegram status messages.

## Commands (`commands/`)

Hot-reloadable `.js` files that handle Telegram `/commands`. Each exports `{ commands: { name: async (ctx, bot, state) => bool } }`. The `ctx` is a grammy Context. Custom commands in `~/.claude/telegram/custom_commands/` override builtins.

## Skills (`skills/`)

Claude Code slash commands: `/telegram:access`, `/telegram:configure`, `/telegram:logs`.

## Key State Files

All under `~/.claude/channels/telegram/`:

- `.env` — `TELEGRAM_BOT_TOKEN`
- `access.json` — allowlist, pairing codes, policies
- `ipc.sock` — Unix socket for shim <-> server communication
- `server.pid` — PID of the standalone server
- `next_session.json` — Transient file written by `/spawn` to pre-assign a session ID to a new shim

## Session Model

Each Claude Code session runs one shim. Shims register with the standalone server over IPC, sending their session ID, PID, cwd, and git branch. One session is "focused" — it receives inbound Telegram messages. `/switch_<id>` changes focus. Outbound replies from any session work regardless of focus.

## `.mcp.json`

The launch command uses `sh -c` to capture `$PWD` into `SESSION_CWD` before `npm --prefix` changes the working directory, so sessions report the correct cwd.
