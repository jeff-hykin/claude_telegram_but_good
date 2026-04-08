/**
 * YAML config system for cbg.
 * Config file: ~/.config/cbg/config.yaml
 */

import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml"
import { join } from "@std/path"

const HOME = Deno.env.get("HOME")!

export function configDir(): string {
  return join(HOME, ".config", "cbg")
}

export function configPath(): string {
  return join(configDir(), "config.yaml")
}

export function readConfig(): Record<string, unknown> {
  try {
    const raw = Deno.readTextFileSync(configPath())
    const parsed = parseYaml(raw)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return {}
    throw err
  }
}

export function writeConfig(config: Record<string, unknown>): void {
  const dir = configDir()
  Deno.mkdirSync(dir, { recursive: true })
  Deno.writeTextFileSync(configPath(), stringifyYaml(config))
}

export function getConfig(key: string): unknown {
  const config = readConfig()
  return config[key]
}

/**
 * Set a config value. The value string is YAML-parsed so that
 * `true` → boolean, `42` → number, `"hello"` → string, etc.
 */
export function setConfig(key: string, yamlValue: string): void {
  const config = readConfig()
  config[key] = parseYaml(yamlValue)
  writeConfig(config)
}

/**
 * Get the Telegram bot token from config (primary) or legacy .env (fallback).
 */
export function getBotToken(): string | undefined {
  const token = getConfig("telegram_bot_token") as string | undefined
  if (token) return token

  // Legacy fallback: read from ~/.claude/channels/telegram/.env
  try {
    const envFile = join(HOME, ".claude", "channels", "telegram", ".env")
    const content = Deno.readTextFileSync(envFile)
    for (const line of content.split("\n")) {
      const m = line.match(/^TELEGRAM_BOT_TOKEN=(.*)$/)
      if (m) return m[1]
    }
  } catch {}

  return undefined
}
