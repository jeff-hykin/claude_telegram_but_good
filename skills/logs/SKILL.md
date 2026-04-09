---
name: logs
description: Show the location of the Telegram channel server log and optionally tail recent entries. Use when the user asks where the logs are, wants to check server output, or is debugging the Telegram channel.
user-invocable: true
allowed-tools:
  - Read
  - Bash(wc *)
  - Bash(tail *)
---

# /telegram:logs — Server Log Location

The Telegram MCP server writes debug output to `~/.local/share/cbg/state/main.log`.

Arguments passed: `$ARGUMENTS`

---

## No args — show location and recent entries

1. Tell the user the log path: `~/.local/share/cbg/state/main.log`
2. Show the line count (`wc -l`).
3. Show the last 30 lines so the user can see recent activity.

## `tail` or a number — show more

If `$ARGUMENTS` is `tail` or a number, show that many lines from the end (default 50).

## `path` — just print the path

Print only the absolute path, useful for piping to other tools.
