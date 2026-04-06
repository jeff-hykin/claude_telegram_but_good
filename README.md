# Claude Telegram But Good

The claude telegram plugin is kinda bad:
- Install is confusing, no warnings/messages when it crashes
- Doesn't allow switching between multiple claude codes
- No cancel (e.g. ctrl+c)
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

Then DM your bot on Telegram.<br>
E.g.
- go to the botfather chat, look for "You will find it at < url >" click the url
- send a dm (any dm)
- it should respond with something like `/telegram:access pair 398a98`

Paste that into your active claude-code session

### 4. Start claude-ing

IMPORTANT:If you want to control a claude code session to be controllable by telegram it must be started with:

```sh
claude --channels plugin:telegram@jeff-hykin-claude-telegram-but-good
```

## Access control

See **[ACCESS.md](./ACCESS.md)** for DM policies, groups, mention detection, delivery config, skill commands, and the `access.json` schema.

Quick reference: IDs are **numeric user IDs** (get yours from [@userinfobot](https://t.me/userinfobot)). Default policy is `pairing`. `ackReaction` only accepts Telegram's fixed emoji whitelist.

## Tools exposed to Claude

| Tool | Purpose |
| --- | --- |
| `reply` | Send to a chat. Takes `chat_id` + `text`, optionally `reply_to` (message ID) for native threading and `files` (absolute paths) for attachments. Images (`.jpg`/`.png`/`.gif`/`.webp`) send as photos with inline preview; other types send as documents. Max 50MB each. Auto-chunks text; files send as separate messages after the text. Returns the sent message ID(s). |
| `react` | Add an emoji reaction to a message by ID. **Only Telegram's fixed whitelist** is accepted (👍 👎 ❤ 🔥 👀 etc). |
| `edit_message` | Edit a message the bot previously sent. Useful for "working…" → result progress updates. Only works on the bot's own messages. |

Inbound messages trigger a typing indicator automatically — Telegram shows
"botname is typing…" while the assistant works on a response.

## Photos

Inbound photos are downloaded to `~/.claude/channels/telegram/inbox/` and the
local path is included in the `<channel>` notification so the assistant can
`Read` it. Telegram compresses photos — if you need the original file, send it
as a document instead (long-press → Send as File).

## No history or search

Telegram's Bot API exposes **neither** message history nor search. The bot
only sees messages as they arrive — no `fetch_messages` tool exists. If the
assistant needs earlier context, it will ask you to paste or summarize.

This also means there's no `download_attachment` tool for historical messages
— photos are downloaded eagerly on arrival since there's no way to fetch them
later.
