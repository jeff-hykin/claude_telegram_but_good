// ---------------------------------------------------------------------------
// lib/config-manager.js — the single source of truth for runtime tunables.
//
// Config file: paths.CONFIG_FILE (JSON). Always read fresh from disk on
// every access, so editing the file hot-reloads the value on the next
// getter call. When the file can't be parsed, we write the in-RAM snapshot
// back to heal the corruption and continue serving the last known good.
//
// Callers should use the typed accessors below (getEventQueueMax,
// getHandlerWarnMs, getToolCallTimeoutMs, getPersistenceDebounceMs,
// getBotToken, getPermissionArgs) so the list of keys stays discoverable.
//
// There is NO caching on reads — every call hits the disk. JSON.parse on
// a small file is sub-millisecond, and the fresh-read semantics are
// load-bearing: they're how hot-reload works for tunables without having
// to bump cbgVersion.
// ---------------------------------------------------------------------------

import { versionedImport } from "./version.js"
import { parseYaml } from "../imports.js"

const { dbg } = await versionedImport("./logging.js", import.meta)
const { paths } = await versionedImport("./paths.js", import.meta)

// ── Defaults / in-RAM snapshot ─────────────────────────────────────────
// Seeded from DEFAULTS at module load. Updated on every successful
// read (so the in-RAM copy always reflects the last known good value).
// Used as the auto-heal target when the file can't be parsed.

const DEFAULTS = Object.freeze({
    // Event loop back-pressure + slow-handler warning.
    event_queue_max: 128,
    handler_warn_ms: 20_000,

    // Shim → server tool call timeout.
    tool_call_timeout_ms: 60_000,

    // Debounced persistence writer (specialData/chatState/chatSessions).
    persistence_debounce_ms: 500,

    // Cold-storage archival of per-chat Telegram hook traffic
    // (Pre/PostToolUse + Stop). Off by default — hooks.jsonl grows fast
    // and the spinner rolling buffer is the primary UX surface for this
    // data. Flip to true for diagnostics or audit-trail use cases.
    hooks_archive: false,

    // Onboarding-managed.
    telegram_bot_token: null,
    permission_mode: null,
})

let inRam = { ...DEFAULTS }

// ── Raw file I/O ───────────────────────────────────────────────────────

function readRawText() {
    try {
        return Deno.readTextFileSync(paths.CONFIG_FILE)
    } catch (e) {
        if (e instanceof Deno.errors.NotFound) {
            return null
        }
        dbg("CONFIG", `read ${paths.CONFIG_FILE} failed:`, e)
        return null
    }
}

function writeAtomic(obj) {
    try {
        Deno.mkdirSync(paths.CBG_DIR, { recursive: true })
        const tmp = `${paths.CONFIG_FILE}.tmp.${Deno.pid}`
        Deno.writeTextFileSync(tmp, JSON.stringify(obj, null, 2) + "\n")
        Deno.renameSync(tmp, paths.CONFIG_FILE)
    } catch (e) {
        dbg("CONFIG", `write ${paths.CONFIG_FILE} failed:`, e)
    }
}

/**
 * One-time migration: if config.json is missing but a legacy config.yaml
 * exists in the same directory, read the yaml and write its contents as
 * config.json. Runs silently on first read — no-op once the JSON file
 * exists.
 */
function maybeMigrateLegacyYaml() {
    const legacyYaml = paths.CONFIG_FILE.replace(/\.json$/, ".yaml")
    if (legacyYaml === paths.CONFIG_FILE) {
        return null
    }
    try {
        const raw = Deno.readTextFileSync(legacyYaml)
        const parsed = parseYaml(raw)
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            dbg("CONFIG", `migrating legacy ${legacyYaml} → ${paths.CONFIG_FILE}`)
            writeAtomic(parsed)
            return parsed
        }
    } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) {
            dbg("CONFIG", `legacy yaml migration skipped:`, e)
        }
    }
    return null
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Read the config fresh from disk. On successful parse, updates the
 * in-RAM snapshot. On parse failure, writes the in-RAM snapshot back
 * to the file (auto-heal) and returns in-RAM.
 *
 * Always returns a fresh object — callers can mutate it without
 * affecting the in-RAM copy.
 */
export function getConfig() {
    const raw = readRawText()
    if (raw === null) {
        const migrated = maybeMigrateLegacyYaml()
        if (migrated) {
            inRam = { ...DEFAULTS, ...migrated }
            return { ...inRam }
        }
        // File missing entirely — write current in-RAM so it exists
        // for inspection and editing.
        writeAtomic(inRam)
        return { ...inRam }
    }
    try {
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("config root must be a JSON object")
        }
        inRam = { ...DEFAULTS, ...parsed }
        return { ...inRam }
    } catch (e) {
        dbg("CONFIG", `parse failed, auto-healing from in-RAM: ${e instanceof Error ? e.message : e}`)
        writeAtomic(inRam)
        return { ...inRam }
    }
}

/**
 * Merge a patch into the config and write it atomically. `patch` is a
 * plain object of key → value pairs. Unknown keys are preserved.
 *
 * Example:
 *     setConfig({ telegram_bot_token: "123:abc", handler_warn_ms: 30000 })
 */
export function setConfig(patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        dbg("CONFIG", "setConfig: patch must be a plain object, got:", patch)
        return
    }
    const current = getConfig()
    const merged = { ...current, ...patch }
    inRam = merged
    writeAtomic(merged)
}

/**
 * Read a single key with a fallback. Always fresh-read. Returns
 * `fallback` if the key is missing, null, or undefined.
 */
export function getConfigKey(key, fallback) {
    const value = getConfig()[key]
    return value === null || value === undefined ? fallback : value
}

// ── Typed tunable accessors ────────────────────────────────────────────
// Each one fresh-reads, coerces to number, falls back to the default if
// the config value is missing or not a finite number. Call these at the
// point of use — do NOT hoist into a module-level constant, or the
// fresh-read semantics are lost.

export function getEventQueueMax() {
    const n = Number(getConfigKey("event_queue_max", DEFAULTS.event_queue_max))
    return Number.isFinite(n) && n > 0 ? n : DEFAULTS.event_queue_max
}

export function getHandlerWarnMs() {
    const n = Number(getConfigKey("handler_warn_ms", DEFAULTS.handler_warn_ms))
    return Number.isFinite(n) && n > 0 ? n : DEFAULTS.handler_warn_ms
}

export function getToolCallTimeoutMs() {
    const n = Number(getConfigKey("tool_call_timeout_ms", DEFAULTS.tool_call_timeout_ms))
    return Number.isFinite(n) && n > 0 ? n : DEFAULTS.tool_call_timeout_ms
}

export function getPersistenceDebounceMs() {
    const n = Number(getConfigKey("persistence_debounce_ms", DEFAULTS.persistence_debounce_ms))
    return Number.isFinite(n) && n >= 0 ? n : DEFAULTS.persistence_debounce_ms
}

/**
 * True if the caller should append Pre/PostToolUse + Stop hook events to
 * cold-storage/hooks.jsonl. Fresh-read so flipping the flag takes
 * effect on the next hook without a daemon restart.
 */
export function getHooksArchiveEnabled() {
    const v = getConfigKey("hooks_archive", DEFAULTS.hooks_archive)
    return v === true
}

// ── Bot token + permission mode ────────────────────────────────────────

/**
 * Primary: config.telegram_bot_token. Fallback: legacy
 * paths.ENV_FILE with a TELEGRAM_BOT_TOKEN=... line, for installs that
 * predate the config file.
 */
export function getBotToken() {
    const fromConfig = getConfig().telegram_bot_token
    if (fromConfig) {
        return fromConfig
    }
    try {
        const content = Deno.readTextFileSync(paths.ENV_FILE)
        for (const line of content.split("\n")) {
            const m = line.match(/^TELEGRAM_BOT_TOKEN=(.*)$/)
            if (m) {
                return m[1]
            }
        }
    } catch (e) {
        dbg("CONFIG", "no legacy .env file, falling through:", e)
    }
    return undefined
}

export function setBotToken(token) {
    setConfig({ telegram_bot_token: token })
}

/**
 * Return the claude-CLI permission-mode flag(s) derived from
 * config.permission_mode. Empty string means "default — no flag".
 */
export function getPermissionArgs() {
    const mode = getConfig().permission_mode
    if (!mode) {
        return ""
    }
    if (mode === "all" || mode === "bypassPermissions") {
        return "--dangerously-skip-permissions"
    }
    return `--permission-mode ${mode}`
}

export function setPermissionMode(mode) {
    setConfig({ permission_mode: mode })
}

// ── Exposed for the CLI `cbg config` command ───────────────────────────
// The CLI accepts string arguments and wants to parse them YAML-style
// (`true` → boolean, `42` → number, `hello` → string). We expose a
// helper so the command doesn't have to re-import YAML.

export function parseCliValue(str) {
    try {
        return JSON.parse(str)
    } catch (e) {
        dbg("CONFIG", `parseCliValue: falling back to string literal for "${str}":`, e)
        return str
    }
}

// Expose the defaults map for CLI introspection ("what keys exist?").
export const CONFIG_DEFAULTS = DEFAULTS
