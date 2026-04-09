/**
 * YAML config system for cbg.
 * Config file: ~/.config/cbg/config.yaml
 */

import { join, parseYaml, stringifyYaml } from "../imports.js"

const HOME = Deno.env.get("HOME")

export function configDir() {
    return join(HOME, ".config", "cbg")
}

export function configPath() {
    return join(configDir(), "config.yaml")
}

export function readConfig() {
    try {
        const raw = Deno.readTextFileSync(configPath())
        const parsed = parseYaml(raw)
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed
        }
        return {}
    } catch (err) {
        if (err instanceof Deno.errors.NotFound) {
            return {}
        }
        throw err
    }
}

export function writeConfig(config) {
    const dir = configDir()
    Deno.mkdirSync(dir, { recursive: true })
    Deno.writeTextFileSync(configPath(), stringifyYaml(config))
}

export function getConfig(key) {
    const config = readConfig()
    return config[key]
}

/**
 * Set a config value. The value string is YAML-parsed so that
 * `true` becomes boolean, `42` becomes number, `"hello"` becomes string, etc.
 */
export function setConfig(key, yamlValue) {
    const config = readConfig()
    config[key] = parseYaml(yamlValue)
    writeConfig(config)
}

/**
 * Get the permission mode for spawned sessions.
 * Returns the CLI flag(s) to pass to claude, or empty string for default.
 */
export function getPermissionArgs() {
    const mode = getConfig("permission_mode")
    if (!mode) {
        return ""
    }
    if (mode === "all" || mode === "bypassPermissions") {
        return "--dangerously-skip-permissions"
    }
    // permission-mode values: acceptEdits, auto, bypassPermissions, default, dontAsk, plan
    return `--permission-mode ${mode}`
}

/**
 * Get the Telegram bot token from config (primary) or legacy .env (fallback).
 */
export function getBotToken() {
    const token = getConfig("telegram_bot_token")
    if (token) {
        return token
    }

    // Legacy fallback: read from ~/.claude/channels/telegram/.env
    try {
        const envFile = join(HOME, ".claude", "channels", "telegram", ".env")
        const content = Deno.readTextFileSync(envFile)
        for (const line of content.split("\n")) {
            const m = line.match(/^TELEGRAM_BOT_TOKEN=(.*)$/)
            if (m) {
                return m[1]
            }
        }
    } catch {
        // no legacy env
    }

    return undefined
}
