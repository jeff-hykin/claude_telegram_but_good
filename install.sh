#!/usr/bin/env bash
set -euo pipefail

# Claude Telegram Plugin Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/jeff-hykin/claude_telegram_but_good/main/install.sh | bash

echo "=== Claude Telegram Plugin Installer ==="
echo ""

# --- Check for Node.js ---
if ! command -v node &>/dev/null; then
  echo "Node.js is not installed. Installing via nvm..."
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  export NVM_DIR="${HOME}/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  nvm install --lts
fi

NODE_VERSION=$(node --version)
echo "Node.js $NODE_VERSION found."

# --- Check for Claude Code ---
if ! command -v claude &>/dev/null; then
  echo ""
  echo "ERROR: Claude Code CLI not found."
  echo "Install it first: https://docs.anthropic.com/en/docs/claude-code/getting-started"
  exit 1
fi

echo "Claude Code found."
echo ""

# --- Install the plugin ---
PLUGIN_DIR="$HOME/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/telegram"
CACHE_DIR="$HOME/.claude/plugins/cache/claude-plugins-official/telegram/0.0.4"
REPO_DIR="$HOME/.claude/channels/telegram-plugin"

echo "Downloading plugin..."
if command -v git &>/dev/null; then
  if [ -d "$REPO_DIR" ]; then
    echo "Updating existing installation..."
    cd "$REPO_DIR" && git pull --quiet
  else
    git clone --quiet https://github.com/jeff-hykin/claude_telegram_but_good.git "$REPO_DIR"
  fi
else
  mkdir -p "$REPO_DIR"
  curl -fsSL https://github.com/jeff-hykin/claude_telegram_but_good/archive/refs/heads/main.tar.gz \
    | tar -xz --strip-components=1 -C "$REPO_DIR"
fi

echo "Installing dependencies..."
cd "$REPO_DIR" && npm install --silent

# Symlink into plugin locations
mkdir -p "$(dirname "$PLUGIN_DIR")"
mkdir -p "$(dirname "$CACHE_DIR")"
rm -rf "$PLUGIN_DIR" "$CACHE_DIR"
ln -s "$REPO_DIR" "$PLUGIN_DIR"
ln -s "$REPO_DIR" "$CACHE_DIR"

# Enable the plugin in settings.json
SETTINGS_FILE="$HOME/.claude/settings.json"
if [ -f "$SETTINGS_FILE" ]; then
  # Use node to merge enabledPlugins without clobbering other keys
  node -e "
    const fs = require('fs');
    const s = JSON.parse(fs.readFileSync('$SETTINGS_FILE', 'utf8'));
    s.enabledPlugins = s.enabledPlugins || {};
    s.enabledPlugins['telegram@claude-plugins-official'] = true;
    fs.writeFileSync('$SETTINGS_FILE', JSON.stringify(s, null, 2) + '\n');
  "
else
  mkdir -p "$(dirname "$SETTINGS_FILE")"
  echo '{"enabledPlugins":{"telegram@claude-plugins-official":true}}' \
    | node -e "process.stdout.write(JSON.stringify(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')),null,2)+'\n')" \
    > "$SETTINGS_FILE"
fi

echo "Plugin installed and enabled."
echo ""

# --- Bot token setup ---
TOKEN_DIR="$HOME/.claude/channels/telegram"
ENV_FILE="$TOKEN_DIR/.env"
ACCESS_FILE="$TOKEN_DIR/access.json"
mkdir -p "$TOKEN_DIR"

if [ -f "$ENV_FILE" ] && grep -q "TELEGRAM_BOT_TOKEN=" "$ENV_FILE"; then
  echo "Bot token already configured."
else
  echo "You need a Telegram bot token from @BotFather."
  echo "  1. Open Telegram and message @BotFather"
  echo "  2. Send /newbot and follow the prompts"
  echo "  3. Copy the token (looks like 123456789:AAH...)"
  echo ""
  read -rp "Paste your bot token (or press Enter to skip): " TOKEN

  if [ -n "$TOKEN" ]; then
    echo "TELEGRAM_BOT_TOKEN=$TOKEN" >> "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    echo "Token saved."
  else
    echo "Skipped. Set it later:"
    echo "  echo 'TELEGRAM_BOT_TOKEN=<your-token>' > $ENV_FILE && chmod 600 $ENV_FILE"
  fi
fi

echo ""

# --- User ID / access setup ---
if [ -f "$ACCESS_FILE" ]; then
  EXISTING=$(node -e "const a=JSON.parse(require('fs').readFileSync('$ACCESS_FILE','utf8')); console.log((a.allowFrom||[]).join(', '))")
  if [ -n "$EXISTING" ]; then
    echo "Allowed users already configured: $EXISTING"
  fi
else
  echo "To skip pairing, enter your Telegram user ID."
  echo "  (Get it by messaging @userinfobot on Telegram)"
  echo ""
  read -rp "Your Telegram user ID (or press Enter to use pairing later): " USER_ID

  if [ -n "$USER_ID" ]; then
    cat > "$ACCESS_FILE" << EOF
{
  "dmPolicy": "allowlist",
  "allowFrom": ["$USER_ID"],
  "groups": {},
  "pending": {}
}
EOF
    mkdir -p "$TOKEN_DIR/approved"
    echo "$USER_ID" > "$TOKEN_DIR/approved/$USER_ID"
    echo "User $USER_ID added to allowlist."
  else
    echo "Skipped. You can pair later by DMing the bot and running:"
    echo "  /telegram:access pair <code>"
  fi
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Start Claude Code with Telegram:"
echo ""
echo "  claude --channels plugin:telegram@claude-plugins-official"
echo ""
echo "For unattended use (no permission prompts):"
echo ""
echo "  claude --dangerously-skip-permissions --channels plugin:telegram@claude-plugins-official"
echo ""
