// ---------------------------------------------------------------------------
// lib/pure/shell-cwd.js — pure helpers for `#` shell-command pwd state.
//
// Pure (no I/O): the directory existence check is left to the caller
// so this module stays unit-testable without a temp-fs setup.
// ---------------------------------------------------------------------------

/**
 * Per-topic key for shell pwd + active proc tracking.
 * Format: `<chatId>:<threadId>` (threadId empty string for DMs).
 */
export function topicShellKey(chatId, threadId) {
    const t = threadId == null || threadId === "" ? "" : String(threadId)
    return `${String(chatId)}:${t}`
}

/**
 * Strip a leading `~` or `~/` segment, replacing with the given home dir.
 * Returns the path unchanged if no leading `~`.
 */
export function expandHome(path, homeDir) {
    if (!path) { return path }
    if (path === "~") { return homeDir }
    if (path.startsWith("~/")) { return homeDir + path.slice(1) }
    return path
}

/**
 * Parse a `# ...` body. Returns one of:
 *   { kind: "cd", target: <raw arg> }
 *   { kind: "cd-home" }
 *   { kind: "exec", cmd: <raw cmd> }
 *   { kind: "empty" }
 *
 * `cd` is hardcoded so we maintain pwd across messages without
 * actually shelling out.
 */
export function parseShellMessage(body) {
    const trimmed = body.trim()
    if (trimmed.length === 0) { return { kind: "empty" } }
    if (trimmed === "cd") { return { kind: "cd-home" } }
    const cdMatch = /^cd\s+(.+)$/.exec(trimmed)
    if (cdMatch) {
        return { kind: "cd", target: cdMatch[1].trim() }
    }
    return { kind: "exec", cmd: trimmed }
}

/**
 * Join `currentCwd` with a `cd` target, expanding `~`. Does NOT
 * normalize `..` etc — that's the OS's job. Caller validates
 * existence via Deno.statSync.
 */
export function resolveCdTarget(currentCwd, target, homeDir) {
    if (!target) { return currentCwd }
    const expanded = expandHome(target, homeDir)
    if (expanded.startsWith("/")) { return expanded }
    // Relative to currentCwd
    const base = currentCwd.endsWith("/") ? currentCwd.slice(0, -1) : currentCwd
    return `${base}/${expanded}`
}
