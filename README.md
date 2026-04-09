# cbg — Claude Telegram But Good

The claude telegram plugin is kinda bad:
- Install is confusing, no warnings/messages when it crashes
- Doesn't allow switching between multiple claude codes
- No cancel (e.g. ctrl+c)
- No way to starting new claude sessions from telegram
- Doesn't allow adding custom telegram commands/skills
- If you telegram-reply to a message (as a reference) the bot has no idea whats being referenced
- No killing, force killing, pausing, resuming claude sessions
- No way to add telegram commands (no hot reloading of changes)
- etc

I made this fork of the offical telegram support cause my team and I were annoyed by these limitations.

## Quick Setup

```sh
# Install deno if you don't have it
curl -fsSL https://deno.land/install.sh | sh

# Install the `cbg` command
deno install -Agfr -n cbg https://raw.githubusercontent.com/jeff-hykin/claude_telegram_but_good/refs/heads/master/mod.js

# Run onboarding (will help setup a bot)
cbg onboard
```

## CLI Reference

| Command | Description |
| --- | --- |
| `cbg onboard` | Full setup: dtach, bot token, Claude plugin registration |
| `cbg start` | Start the daemon (creates a systemd/launchd service) |
| `cbg stop` | Stop the daemon |
| `cbg restart` | Stop + start |
| `cbg new [--title T] [claude args...]` | Create a new dtach session. `--title` sets the display name; all other args pass through to `claude` (e.g. `cbg new --title "refactor" resume`, `cbg new --dangerously-skip-permissions`). `--channels` is always included automatically. |
| `cbg resume [id]` | Attach to a dtach session (interactive selector if no id) |
| `cbg status` | Show daemon status + list sessions |
| `cbg config` | Print all config as YAML |
| `cbg config <key>` | Print a single config value |
| `cbg config <key> <value>` | Set a config value (value is YAML-parsed) |

## Telegram Commands

These commands are sent as messages to your bot in Telegram.

| Command | Description |
| --- | --- |
| `/list` | Show all connected sessions with cwd, git branch, and timing info. Tap `/switch_<id>` to change focus. |
| `/cancel` | Send Escape to the focused session via dtach — interrupts whatever Claude is doing. Falls back to SIGINT for non-dtach sessions. |
| `/spawn [title]` | Launch a new Claude Code session in dtach. Auto-switches focus after 3s. |
| `/title <name>` | Set a display name for the focused session. No argument auto-generates from directory + branch. |
| `/ping` | Health check — replies "pong". |
| `/pause` | Suspend the focused session (SIGTSTP). |
| `/resume` | Resume a paused session (SIGCONT). |
| `/kill` | Force kill the focused session (SIGKILL). |
| `/status` | Show pairing status and running Claude processes. |
| `/cron` | List scheduled tasks. |
| `/help` | Show the full command list. |
| `/start` | Show pairing instructions for new users. |

## Custom Commands

Custom commands live in `~/.claude/telegram/custom_commands/` and survive plugin updates.

**From Telegram:** Describe a new command to Claude and it will create it via the `new_command` MCP tool and hot-reload immediately.

**Manually:** Create a `.js` file exporting `{ commands: { name: async (ctx, bot, state) => bool } }`. Use `state.letClaudeHandle(ctx, text?)` to forward messages to Claude while still returning `true`.

If a command throws an error, the bot shows a "Ask Claude to fix" button that sends the error details to the focused session.

## Multi-Session Support

Multiple Claude Code sessions can connect simultaneously. The bot acts as a hub:

- Each session registers via IPC when it starts
- `/list` shows all sessions — tap `/switch_<id>` to change which one receives your messages
- Telegram-reply routing: reply to a bot message to target the session that sent it (via `/switch_<id>` headers)
- `/spawn` creates new sessions from Telegram
- If the focused session disconnects, focus auto-moves to the next available session
- Messages sent when no sessions are connected get queued and delivered when one connects

## Config

Config is stored at `~/.config/cbg/config.yaml`. Currently supported keys:

```yaml
telegram_bot_token: "123456789:AAH..."
```

The bot token is also read from the legacy location (`~/.claude/channels/telegram/.env`) as a fallback.

## Architecture

See [CLAUDE.md](./CLAUDE.md) for the full architecture overview. The short version:

- **`shim.ts`** — MCP server loaded by Claude Code, one per session. Proxies tool calls to the standalone server over a Unix socket.
- **`standalone-server.ts`** — Long-lived daemon owning the Telegram bot. Routes messages between Telegram and focused sessions.
- **`mod.ts`** — CLI entry point for `cbg`.

Communication uses newline-delimited JSON over `~/.claude/channels/telegram/ipc.sock`.

## Tools Exposed to Claude

| Tool | Purpose |
| --- | --- |
| `reply` | Send to a chat. Supports `reply_to` for threading, `files` for attachments (photos render inline, others as documents). Auto-chunks at 4096 chars. Max 50MB per file. |
| `react` | Add an emoji reaction. Only Telegram's fixed whitelist is accepted. |
| `edit_message` | Edit a previously sent message. Edits don't trigger push notifications. |
| `download_attachment` | Download a file from Telegram to the local inbox (20MB bot API limit). |
| `set_title` | Set a display title for this session. |
| `reload` | Hot-reload command handlers. |
| `new_command` | Create/update a custom command and hot-reload. |
| `enable_telegram_by_default` | Create/remove a shell wrapper so `claude` always has the `--channels` flag. |

## Photos & Attachments

Inbound photos are downloaded to `~/.claude/channels/telegram/inbox/` and the local path is included in the channel notification so Claude can `Read` it. Telegram compresses photos — send as a document (long-press, Send as File) for originals.

Documents, voice messages, audio, video, video notes, and stickers are all supported — their `file_id` is passed in the channel metadata for download via `download_attachment`.

## Access Control

See [ACCESS.md](./ACCESS.md) for DM policies, groups, mention detection, delivery config, and the `access.json` schema.

Quick reference: IDs are numeric user IDs (get yours from [@userinfobot](https://t.me/userinfobot)). Default policy is `pairing`.

## Limitations

- No API for the active model or context usage percentage
- Telegram Bot API has no message history or search — only live messages
- Telegram's emoji reaction whitelist is fixed and small
- Bot file downloads capped at 20MB by Telegram
