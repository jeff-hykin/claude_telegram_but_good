# Claude Telegram But Good

The claude telegram plugin is kinda bad, this one just adds a few things like:
- Listing all claude sessions and choosing which one telegram is connected to
- Cancelling a request (ctrl+c) from telegram
- Killing, force killing, pausing, resuming claude sessions
- Starting new claude sessions from telegram
- etc

## Quick Setup

Before starting, get two things from Telegram:
1. **Bot token** — message [@BotFather](https://t.me/BotFather), send `/newbot`, copy the token (`123456789:AAHfiqksKZ8...`)
2. **Your user ID** — message [@userinfobot](https://t.me/userinfobot), it replies with your numeric ID

Then run these commands:

```sh
# 1. Install node if you don't have it
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.nvm/nvm.sh && nvm install --lts

# 2. Install the plugin
claude plugin marketplace add jeff-hykin/claude_telegram_but_good
claude plugin install telegram@jeff-hykin-claude-telegram-but-good

# 3. Set your bot token
mkdir -p ~/.claude/channels/telegram
echo 'TELEGRAM_BOT_TOKEN=<your-token>' > ~/.claude/channels/telegram/.env
chmod 600 ~/.claude/channels/telegram/.env

# 4. Allow your Telegram user ID (skips interactive pairing)
cat > ~/.claude/channels/telegram/access.json << 'EOF'
{
  "dmPolicy": "allowlist",
  "allowFrom": ["<your-user-id>"],
  "groups": {},
  "pending": {}
}
EOF

# 5. Start Claude Code with Telegram
claude --channels plugin:telegram@jeff-hykin-claude-telegram-but-good
```

That's it. DM your bot and it reaches Claude.

> For unattended use: `claude --dangerously-skip-permissions --channels plugin:telegram@jeff-hykin-claude-telegram-but-good`

> To run multiple bots on one machine, set `TELEGRAM_STATE_DIR` to a different directory per instance.

## Access control

See **[ACCESS.md](./ACCESS.md)** for DM policies, groups, mention detection, delivery config, skill commands, and the `access.json` schema.

Quick reference: IDs are **numeric user IDs** (get yours from [@userinfobot](https://t.me/userinfobot)). Default policy is `pairing`. `ackReaction` only accepts Telegram's fixed emoji whitelist.

## Tools exposed to the assistant

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
