/**
 * YAML config system for cbg.
 */

import { parseYaml, stringifyYaml } from "../imports.js"
import { ENV_FILE, CONFIG_DIR, CONFIG_FILE } from "./protocol.js"

export function readConfig() {
    try {
        const raw = Deno.readTextFileSync(CONFIG_FILE)
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
    const dir = CONFIG_DIR
    Deno.mkdirSync(dir, { recursive: true })
    Deno.writeTextFileSync(CONFIG_FILE, stringifyYaml(config))
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

    // Legacy fallback: read from state dir .env
    try {
        const envFile = ENV_FILE
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
