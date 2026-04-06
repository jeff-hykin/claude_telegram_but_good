#!/usr/bin/env bash
set -euo pipefail

# Claude Telegram Plugin Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/<owner>/claude_telegram_but_good/main/install.sh | bash

echo "=== Claude Telegram Plugin Installer ==="
echo ""

# --- Check for Node.js ---
if ! command -v node &>/dev/null; then
  echo "Node.js is not installed."
  echo ""
  if command -v brew &>/dev/null; then
    echo "Installing via Homebrew..."
    brew install node
  elif command -v apt-get &>/dev/null; then
    echo "Installing via apt..."
    sudo apt-get update && sudo apt-get install -y nodejs npm
  elif command -v dnf &>/dev/null; then
    echo "Installing via dnf..."
    sudo dnf install -y nodejs npm
  else
    echo "Please install Node.js manually: https://nodejs.org"
    exit 1
  fi
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

echo "Plugin installed."
echo ""

# --- Bot token setup ---
TOKEN_DIR="$HOME/.claude/channels/telegram"
ENV_FILE="$TOKEN_DIR/.env"
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
    echo "  echo 'TELEGRAM_BOT_TOKEN=<your-token>' > $ENV_FILE"
    echo "  chmod 600 $ENV_FILE"
  fi
fi

echo ""

# --- Pairing instructions ---
echo "=== Setup Complete ==="
echo ""
echo "To start Claude Code with Telegram:"
echo ""
echo "  claude --channels plugin:telegram@claude-plugins-official"
echo ""
echo "Then pair your Telegram account:"
echo "  1. DM your bot on Telegram — it replies with a 6-char code"
echo "  2. In Claude Code, run: /telegram:access pair <code>"
echo "  3. Lock it down: /telegram:access policy allowlist"
echo ""
echo "For unattended use (no permission prompts):"
echo ""
echo "  claude --dangerously-skip-permissions --channels plugin:telegram@claude-plugins-official"
echo ""
