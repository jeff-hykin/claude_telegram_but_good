# Claude Telegram But Good

The claude telegram plugin is kinda bad:
- Install is confusing, no warnings/messages when it crashes
- Doesn't allow switching between multiple claude codes
- No cancel (e.g. ctrl+c)
- Doesn't allow adding custom telegram commands/skills
- If you telegram-reply to a message (as a reference) the bot has no idea whats being referenced
- No killing, force killing, pausing, resuming claude sessions
- No way to starting new claude sessions from telegram
- No way to add telegram commands (no hot reloading of changes)
- etc

I made this repo cause my team and I were annoyed by these limitations.

## Quick Setup

### 1. Get a bot token

Message [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`, and copy the token (`123456789:AAHfiqksKZ8...`).

### 2. Install the plugin

Paste your token on the first line and run:

```sh
BOT_TOKEN=<YOUR_TOKEN_HERE>

# install node if you don't have it
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.nvm/nvm.sh && nvm install --lts

# install the plugin
claude plugin marketplace add jeff-hykin/claude_telegram_but_good
claude plugin install telegram@jeff-hykin-claude-telegram-but-good

# save the bot token
mkdir -p ~/.claude/channels/telegram
echo "TELEGRAM_BOT_TOKEN=$BOT_TOKEN" > ~/.claude/channels/telegram/.env
chmod 600 ~/.claude/channels/telegram/.env
```

### 3. Approve yourself

Start the telegram server by opening a connected claude session:

```sh
claude --channels plugin:telegram@jeff-hykin-claude-telegram-but-good
```

DM your bot on Telegram.<br>
E.g.
- go to the botfather chat, look for "You will find it at < url >" click the url
- send a dm (any dm)
- it should respond with something like `/telegram:access pair 398a98`

Paste that into the claude-code session you just started.

### 4. Start claude-ing

IMPORTANT: If you want to control a claude code session to be controllable by telegram it must be started with:

```sh
claude --channels plugin:telegram@jeff-hykin-claude-telegram-but-good
```

## Telegram Commands

These commands are sent as messages to your bot in Telegram.

| Command | Description |
| --- | --- |
| `/list` | Show all connected Claude Code sessions with working directory, git branch, start time, and last active time. The active session is marked with ▶. Tap `/switch_<id>` to change which session receives your messages. |
| `/cancel` | Send Ctrl+C (SIGINT) to the active session — gracefully interrupts whatever Claude is doing. |
| `/title <name>` | Set a custom display name for the active session (shown in `/list`). With no argument, auto-generates a name from the directory and git branch. |
| `/spawn_d` | Launch a new Claude Code session in a new terminal pane (uses zellij or tmux). It appears in `/list` once it connects. |
| `/ping` | Health check — replies "pong" if the bot is alive. |
| `/pause` | Suspend the active session (SIGTSTP, like Ctrl+Z). Claude stops working but stays in memory. |
| `/resume` | Resume a paused session (SIGCONT). |
| `/fkill` | Force kill the active session (SIGKILL). No graceful shutdown — use when `/cancel` isn't enough. |
| `/fkill_all` | Force kill **all** connected Claude Code sessions. You'll need to restart them manually. |
| `/cron` | List scheduled tasks (desktop scheduled tasks and in-session cron jobs). |
| `/status` | Show your pairing status and all running Claude Code processes. |
| `/new_command` | Show how to create custom commands. Includes the file format, available state APIs, and tells you to ask Claude in your session to create one. |
| `/start` | Show pairing instructions for new users. |
| `/help` | Show the full command list. |

## Multi-Session Support

You can run multiple Claude Code sessions simultaneously, each started with `--channels`. The bot acts as a hub:

- **One primary** session handles Telegram polling and bot commands
- **Secondaries** register via IPC and can receive forwarded messages
- `/list` shows all sessions — tap `/switch_<id>` to change which one gets your messages
- `/title` lets you label sessions so you can tell them apart (e.g. "backend (feature-x)")
- If the primary dies, a secondary auto-promotes to keep the bot online

## Photos

Inbound photos are downloaded to `~/.claude/channels/telegram/inbox/` and the
local path is included in the `<channel>` notification so the assistant can
`Read` it. Telegram compresses photos — if you need the original file, send it
as a document instead (long-press → Send as File).

## Limitations

There's no API for the active model or the context usage percent, which is unfortunate.

## Access control

See **[ACCESS.md](./ACCESS.md)** for DM policies, groups, mention detection, delivery config, skill commands, and the `access.json` schema.

Quick reference: IDs are **numeric user IDs** (get yours from [@userinfobot](https://t.me/userinfobot)). Default policy is `pairing`. `ackReaction` only accepts Telegram's fixed emoji whitelist.

## Tools exposed to Claude

| Tool | Purpose |
| --- | --- |
| `reply` | Send to a chat. Takes `chat_id` + `text`, optionally `reply_to` (message ID) for native threading and `files` (absolute paths) for attachments. Images (`.jpg`/`.png`/`.gif`/`.webp`) send as photos with inline preview; other types send as documents. Max 50MB each. Auto-chunks text; files send as separate messages after the text. Returns the sent message ID(s). |
| `react` | Add an emoji reaction to a message by ID. **Only Telegram's fixed whitelist** is accepted (👍 👎 ❤ 🔥 👀 etc). |
| `edit_message` | Edit a message the bot previously sent. Useful for "working…" → result progress updates. Only works on the bot's own messages. |
| `download_attachment` | Download a file attachment from a Telegram message to the local inbox. Use when the inbound message has an `attachment_file_id`. Telegram caps bot downloads at 20MB. |
| `set_title` | Set a display title for this session in the Telegram `/list` view (e.g. "denix refactor"). |
| `reload` | Hot-reload command handlers from the `commands/` directory. Use after editing command files so changes take effect without restarting the server. |
| `new_command` | Create or update a custom Telegram bot command and hot-reload it immediately. Takes a `filename` and `code` — writes to `~/.claude/telegram/custom_commands/` (survives plugin updates) and reloads in one step. Custom commands override builtins with the same name. Ask Claude to "add a /weather command" and it just works. |

Inbound messages trigger a typing indicator automatically — Telegram shows
"botname is typing…" while the assistant works on a response.
