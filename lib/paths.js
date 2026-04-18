// ---------------------------------------------------------------------------
// lib/paths.js — central path definitions.
//
// CBG's filesystem layout is a pure function of TWO inputs:
//
//   - CBG_DIR     (default: $HOME/.local/share/cbg)
//   - CLAUDE_DIR  (default: $HOME/.claude)
//
// Everything else is derived. Call `buildPaths({ cbgDir, claudeDir })` to
// get the full set. The default export `paths` is pre-built from environment
// variables for convenience — most callers want that.
//
// Layout:
//
//   $CBG_DIR/
//     config.json              ← CBG's single config file (JSON, hot-reloadable)
//     repo/                    ← CBG source checkout (install location)
//     state/                   ← runtime state (sockets, pids, logs, json)
//     long-tasks/              ← on-disk task directories
//     debug/                   ← server dumps and ad-hoc debug files
//
//   $CLAUDE_DIR/
//     settings.json            ← hooks registration, etc (OWNED BY CLAUDE CODE)
//     plugins/                 ← plugin cache + marketplace dirs we patch
//
// This file has no dependencies other than the pinned esm.sh modules in
// imports.js — keep it flat and easy to read.
// ---------------------------------------------------------------------------

import { join } from "../imports.js"

// Module-private — not exported. Consumers read `paths.HOME`.
const HOME = Deno.env.get("HOME")

// Service-manager identifiers — used both as path components (in
// SYSTEMD_SERVICE_FILE / LAUNCHD_PLIST_FILE) and as CLI arguments in
// daemon.js (systemctl ... <name> / launchctl list <label>).
const SERVICE_NAME = "cbg-telegram"
const LAUNCHD_LABEL = "com.cbg.telegram"

/**
 * Build the full path object from two root directories.
 *
 * @param {{ cbgDir: string, claudeDir: string }} roots
 * @returns {Record<string, any>} all derived paths
 */
export function buildPaths({ cbgDir, claudeDir }) {
    const stateDir = join(cbgDir, "state")
    const repoDir = join(cbgDir, "repo")
    const debugDir = join(cbgDir, "debug")
    const longTasksDir = join(cbgDir, "long-tasks")
    const scheduledTasksDir = join(cbgDir, "scheduled-tasks")
    const topicsDir = join(cbgDir, "topics")
    const coldStorageDir = join(stateDir, "cold-storage")
    const systemdUserDir = join(HOME, ".config", "systemd", "user")
    const launchdAgentsDir = join(HOME, "Library", "LaunchAgents")
    const claudePluginsDir = join(claudeDir, "plugins")

    return {
        // Roots (for convenience)
        CBG_DIR: cbgDir,
        HOME,

        // Service-manager identifiers (paths+CLI args)
        SERVICE_NAME,
        LAUNCHD_LABEL,

        // CBG top-level
        CONFIG_FILE: join(cbgDir, "config.json"),
        LOCAL_REPO: repoDir,
        STATE_DIR: stateDir,
        LONG_TASKS_DIR: longTasksDir,
        SCHEDULED_TASKS_DIR: scheduledTasksDir,
        TOPICS_DIR: topicsDir,

        // CBG state directory (runtime)
        ACCESS_FILE: join(stateDir, "access.json"),
        APPROVED_DIR: join(stateDir, "approved"),
        ENV_FILE: join(stateDir, ".env"),
        IPC_SOCK: join(stateDir, "ipc.sock"),
        INBOX_DIR: join(stateDir, "inbox"),
        PID_FILE: join(stateDir, "server.pid"),
        STOPPED_FILE: join(stateDir, "server.stopped"),
        LOG_FILE: join(stateDir, "main.log"),
        DAEMON_STDERR_FILE: join(stateDir, "daemon.stderr.log"),
        DAEMON_STDOUT_FILE: join(stateDir, "daemon.stdout.log"),
        MESSAGES_FILE: join(stateDir, "messages.jsonl"),
        CUSTOM_COMMANDS_DIR: join(cbgDir, "custom_commands"),
        COLD_STORAGE_DIR: coldStorageDir,

        // Per-run single-file state
        NEXT_SESSION_FILE: join(stateDir, "next_session.json"),
        PERMISSION_ARGS_FILE: join(stateDir, "permission_args"),

        // CBG repo (install location) — used in hook + service registration
        HOOK_PATH: join(repoDir, "event-generators", "hooks", "run-hook"),
        MAIN_SERVER_JS: join(repoDir, "main-server.js"),
        MCP_SHIM_JS: join(repoDir, "event-generators", "mcp-server", "mcp-shim.js"),

        // Service-manager files (macOS launchd / Linux systemd)
        SYSTEMD_USER_DIR: systemdUserDir,
        SYSTEMD_SERVICE_FILE: join(systemdUserDir, `${SERVICE_NAME}.service`),
        LAUNCHD_AGENTS_DIR: launchdAgentsDir,
        LAUNCHD_PLIST_FILE: join(launchdAgentsDir, `${LAUNCHD_LABEL}.plist`),

        // Claude Code's directory (NOT owned by CBG — read/patch carefully)
        CLAUDE_SETTINGS: join(claudeDir, "settings.json"),
        CLAUDE_PLUGIN_CACHE_DIR: join(claudePluginsDir, "cache", "claude-plugins-official", "telegram"),
        CLAUDE_PLUGIN_EXTERNAL_DIR: join(claudePluginsDir, "marketplaces", "claude-plugins-official", "external_plugins", "telegram"),

        // ── Dynamic helpers for per-id paths ─────────────────────────
        // Closures over the resolved dirs above — safe to destructure
        // (they don't use `this`). Name them camelCase so call sites
        // look like `paths.dtachSockFile(id)` instead of
        // `DTACH_SOCK_FILE(id)`.

        // `cbg claude` uses a 6-char random-hex id, the mcp-server/new
        // command use human-friendly session names — both land on this
        // pattern so `cbg resume` and the dtach discovery regex match.
        dtachSockFile(sessionId) {
            return join(stateDir, `dtach-${sessionId}.sock`)
        },
        dtachLogFile(sessionId) {
            return join(stateDir, `dtach-${sessionId}.log`)
        },
        longTaskDir(taskId) {
            return join(longTasksDir, taskId)
        },
        scheduledTaskDir(id) {
            return join(scheduledTasksDir, id)
        },
        scheduledTaskRunDir(id, iso) {
            return join(scheduledTasksDir, id, "runs", iso)
        },
        scheduledTaskDtachSock(id, iso) {
            return join(scheduledTasksDir, id, "runs", iso, "dtach.sock")
        },
        scheduledTaskDtachLog(id, iso) {
            return join(scheduledTasksDir, id, "runs", iso, "dtach.log")
        },
        /**
         * Cold-backup location for a task's definition-of-done markdown.
         * Written when `long_task_definition_submitted` is handled;
         * deleted when the task terminates (certified or cancelled).
         * Lives inside STATE_DIR (not longTasksDir) because it's a
         * restart-recovery artifact, not part of the task's on-disk
         * working set.
         */
        longTaskDefinitionBackupFile(taskId) {
            return join(stateDir, "long-task-definitions", `${taskId}.md`)
        },
        topicDir(threadId) {
            return join(topicsDir, String(threadId))
        },
        topicMemoryFile(threadId) {
            return join(topicsDir, String(threadId), "memory.md")
        },
        coldStorageStreamFile(stream) {
            return join(coldStorageDir, `${stream}.jsonl`)
        },
        persistenceFile(which) {
            return join(stateDir, `${which}.json`)
        },

        /**
         * Compute a timestamped dump path. Each call returns a FRESH path
         * so successive dumps don't overwrite each other.
         */
        makeDumpPath() {
            const date = new Date().toISOString().replace(/[:.]/g, "-")
            return join(debugDir, `${date}.cbg-dump.json`)
        },
    }
}

// ── Default roots from environment ─────────────────────────────────────
//
// Both CBG_DIR and CLAUDE_DIR can be overridden via env vars. The defaults
// are stable XDG-ish locations: $HOME/.local/share/cbg and $HOME/.claude.

const CBG_DIR_DEFAULT = Deno.env.get("CBG_DIR") ?? join(HOME, ".local", "share", "cbg")
const CLAUDE_DIR_DEFAULT = Deno.env.get("CLAUDE_DIR") ?? join(HOME, ".claude")

// ── Pre-built default paths object ─────────────────────────────────────
//
// This is the SINGLE public surface of this module. Consumers do
//     import { paths } from "./paths.js"
//     ... paths.STATE_DIR ...
// so tests can swap `paths` for a buildPaths({...}) override without
// having to re-import every named constant individually.

export const paths = buildPaths({
    cbgDir: CBG_DIR_DEFAULT,
    claudeDir: CLAUDE_DIR_DEFAULT,
})
