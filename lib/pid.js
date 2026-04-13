// ---------------------------------------------------------------------------
// lib/pid.js — process-tree ancestry walk for locating the Claude Code PID.
//
// Callers need to know which `claude` process owns the current shell / hook
// invocation. Deno.ppid gives us only the immediate parent, but in practice
// the claude binary may be several layers up (shim wrapper → bash → claude,
// or script(1) → bash → claude, etc.). These helpers walk `ps -o ppid=`
// up to 10 levels looking for a real claude process.
//
// Match is on the full command line (`ps -o args=`), NOT `comm`: the kernel's
// `comm` field is truncated to 15 chars and shows only the interpreter for
// shell scripts — so a `claude` shim script reports comm=`sh`, never `claude`.
// ---------------------------------------------------------------------------

import { versionedImport } from "./version.js"

const { dbg } = await versionedImport("./logging.js", import.meta)

// Private — only used by the two ancestry helpers below. Wraps a single
// `sh -c <cmd>` call and returns the trimmed stdout. Not exported because
// anything else in the codebase needing shell should use dax (`$` from
// imports.js) instead.
function execSync(cmd) {
    const result = new Deno.Command("sh", {
        args: ["-c", cmd],
        stdout: "piped",
        stderr: "piped",
    }).outputSync()
    return new TextDecoder().decode(result.stdout).trim()
}

/**
 * Walk up the process tree looking for the Claude Code PID. Returns the PID
 * if a `claude` process is found in the ancestry, or null if not.
 *
 * Used by event-generators/hooks/hook.js so we never tag a hook event with a
 * guessed/fallback PID — the hook sends UNKNOWN_CLAUDE_PID instead and the
 * server's fail-safe path surfaces the event regardless of focus.
 */
export function findClaudePidStrict(startPid) {
    const getppid = (pid) => {
        const r = execSync(`ps -o ppid= -p ${pid}`)
        return r ? parseInt(r) : -1
    }
    const getargs = (pid) => execSync(`ps -o args= -p ${pid}`) || "?"

    let pid = startPid ?? Deno.pid
    for (let i = 0; i < 10; i++) {
        pid = getppid(pid)
        if (pid <= 1) {
            break
        }
        const args = getargs(pid)
        dbg("PID-WALK", `ancestry walk: pid=${pid} args=${args}`)
        // Match "claude" only as the FIRST word of the argv so we don't
        // get fooled by wrapper processes (script/bash/dtach) whose
        // command line happens to mention claude as part of a shell
        // invocation (`bash -c "... && claude --no-tele ..."`).
        //
        // The real claude process shows up in ps with argv rewritten
        // to the bare word `claude` (node/V8 strips its argv after
        // startup), so this regex explicitly allows both the bare
        // form and `/some/path/claude` — what it DOESN'T allow is
        // `claude` anywhere after the first whitespace.
        if (/^(?:\S*\/)?claude(?:\s|$)/i.test(args)) {
            dbg("PID-WALK", `found Claude Code at PID ${pid}`)
            return pid
        }
    }
    return null
}

/**
 * Walk up the process tree looking for a `dtach` ancestor of the given PID.
 * Returns the dtach pid if found, or null.
 *
 * Used by the session-register handler to detect the "SurprisingRooster"
 * case — a claude session that registered with the daemon but has no dtach
 * wrapper in its ancestry, so /peek, /cancel, /pause, /resume can't reach
 * into its terminal. When this returns null the caller surfaces a warning
 * so the user knows to `cbg reinstall`.
 *
 * Match is on the first word of argv (`ps -o args=`), NOT `comm`, for the
 * same reason `findClaudePidStrict` uses args: shell wrappers and scripts
 * rewrite `comm` so a bash script spawning dtach reports comm=`sh`. We
 * also explicitly reject `claude` anywhere in the args — the whole point
 * of this helper is to find a dtach process, not re-find claude.
 */
export function findDtachPidStrict(startPid) {
    if (startPid == null) { return null }
    const getppid = (pid) => {
        const r = execSync(`ps -o ppid= -p ${pid}`)
        return r ? parseInt(r) : -1
    }
    const getargs = (pid) => execSync(`ps -o args= -p ${pid}`) || "?"

    let pid = startPid
    for (let i = 0; i < 10; i++) {
        pid = getppid(pid)
        if (pid <= 1) {
            break
        }
        const args = getargs(pid)
        dbg("PID-WALK", `dtach ancestry walk: pid=${pid} args=${args}`)
        if (/^(?:\S*\/)?dtach(?:\s|$)/.test(args)) {
            dbg("PID-WALK", `found dtach at PID ${pid}`)
            return pid
        }
    }
    return null
}

/**
 * Walk up the process tree to find the Claude Code PID, falling back to the
 * immediate ppid if no claude process is found in the ancestry. Used by the
 * mcp-server shim where SOME pid is required for session registration —
 * hook.js uses the strict variant + UNKNOWN_CLAUDE_PID sentinel instead.
 */
export function findClaudePid(startPid) {
    const found = findClaudePidStrict(startPid)
    if (found != null) {
        return found
    }
    const getppid = (pid) => {
        const r = execSync(`ps -o ppid= -p ${pid}`)
        return r ? parseInt(r) : -1
    }
    const ppid = getppid(startPid ?? Deno.pid)
    dbg("PID-WALK", "could not find claude in ancestry, falling back to ppid:", ppid)
    return ppid > 0 ? ppid : (startPid ?? Deno.pid)
}
