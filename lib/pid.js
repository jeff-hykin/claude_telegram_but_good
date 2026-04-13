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
        if (/\/claude(\s|$)/i.test(args)) {
            dbg("PID-WALK", `found Claude Code at PID ${pid}`)
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
