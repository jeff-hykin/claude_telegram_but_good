// ---------------------------------------------------------------------------
// lib/pure/long-runs.js — the decision half of the long-run warning.
//
// A Claude session runs every Bash tool call (foreground or backgrounded) as
// a direct child `/bin/bash -c source …/shell-snapshots/snapshot-… && eval
// '<command>' …` of its claude process (`session.pid`). That wrapper lives
// exactly as long as the command, so its elapsed time IS the command's run
// time and its `eval '…'` argument is the command text. Matching only that
// signature leaves out everything else claude parents: MCP servers (the cbg
// shim included), LSP plugins, hook scripts, its own `caffeinate`.
//
// Not seen: commands that detach (`nohup … &`, setsid) and outlive their
// shell, since they reparent to init; anything on a remote machine beyond the
// local `ssh` command that drives it.
// ---------------------------------------------------------------------------

const BASH_TOOL_SHELL = /shell-snapshots\/snapshot-/
const EVAL_ARG = /\beval '((?:[^']|'\\'')*)'/
const COMMAND_PREVIEW_CHARS = 80

/** `ps` etime (`[[dd-]hh:]mm:ss`) → milliseconds, or null if unparseable. */
export function parseEtime(etime) {
    const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(etime ?? "").trim())
    if (!match) {
        return null
    }
    const [, days, hours, minutes, seconds] = match.map((part) => Number(part ?? 0))
    return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000
}

/** `ps -axo pid=,ppid=,etime=,args=` output → [{ pid, ppid, elapsedMs, args }]. */
export function parsePsTable(text) {
    const processes = []
    for (const line of String(text ?? "").split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
        if (!match) {
            continue
        }
        const elapsedMs = parseEtime(match[3])
        if (elapsedMs == null) {
            continue
        }
        processes.push({ pid: Number(match[1]), ppid: Number(match[2]), elapsedMs, args: match[4] })
    }
    return processes
}

/** The command a Bash-tool wrapper shell is running, or null if `args` is not one. */
export function bashToolCommand(args) {
    if (!BASH_TOOL_SHELL.test(args ?? "")) {
        return null
    }
    const evaluated = EVAL_ARG.exec(args)
    return evaluated ? evaluated[1].replaceAll("'\\''", "'") : args
}

/** One line, at most COMMAND_PREVIEW_CHARS long. */
export function commandPreview(command) {
    const oneLine = String(command).replace(/\s+/g, " ").trim()
    return oneLine.length > COMMAND_PREVIEW_CHARS ? oneLine.slice(0, COMMAND_PREVIEW_CHARS - 1) + "…" : oneLine
}

/** 452_000 → "7m32s", 7_380_000 → "2h03m". */
export function formatElapsed(ms) {
    const totalSeconds = Math.floor(ms / 1000)
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    const seconds = totalSeconds % 60
    if (hours > 0) {
        return `${hours}h${String(minutes).padStart(2, "0")}m`
    }
    return `${minutes}m${String(seconds).padStart(2, "0")}s`
}

/** The Bash tool commands running under `claudePid`, oldest first. */
export function bashToolRuns(processes, claudePid) {
    const runs = []
    for (const proc of processes) {
        if (proc.ppid !== claudePid) {
            continue
        }
        const command = bashToolCommand(proc.args)
        if (command != null) {
            runs.push({ pid: proc.pid, elapsedMs: proc.elapsedMs, command })
        }
    }
    return runs.sort((a, b) => b.elapsedMs - a.elapsedMs)
}

export function longRunWarningText(run, { warnAfterMs, othersCount = 0 }) {
    const others = othersCount > 0 ? `, +${othersCount} more` : ""
    return `[automated reminder] A command has been running >${Math.round(warnAfterMs / 60000)} min ` +
        `(${commandPreview(run.command)}, ${formatElapsed(run.elapsedMs)}${others}). ` +
        "Slow iteration is the main thing that turns days into weeks: is there a faster faithful harness " +
        "(cache/replay the unchanged expensive stage, re-solve offline, a small crop) to screen with, " +
        "keeping the full run only to final-validate? Don't wait on it — work on the next independent thing " +
        "in parallel, spread runs across machines, and check back when notified. No reply needed."
}

/**
 * Decide which sessions to warn. Each session carries
 *   longRunWarnedPids: number[]  — runs already warned about (pruned once they exit)
 *   lastLongRunWarnAt: number    — when it was last warned
 * One warning names a session's newest unwarned run past the threshold (the
 * one that just crossed it; older ones are usually wait loops on it) and
 * marks them all as warned, so a batch of parallel runs is one message.
 *
 * @returns {{ sessionPatches: object, warnings: { sessionId: string, text: string }[] }}
 */
export function planLongRunWarnings({ sessions, processes, now, warnAfterMs, cooldownMs }) {
    const sessionPatches = {}
    const warnings = []
    for (const [sessionId, session] of Object.entries(sessions ?? {})) {
        if (!session?._conn || typeof session.pid !== "number" || (session.backend ?? "claude") !== "claude") {
            continue
        }
        const runs = bashToolRuns(processes, session.pid)
        const runningPids = new Set(runs.map((run) => run.pid))
        const previouslyWarned = session.longRunWarnedPids ?? []
        const warned = previouslyWarned.filter((pid) => runningPids.has(pid))
        const fresh = runs.filter((run) => run.elapsedMs >= warnAfterMs && !warned.includes(run.pid))
        const coolingDown = session.lastLongRunWarnAt != null && now - session.lastLongRunWarnAt < cooldownMs

        if (fresh.length > 0 && !coolingDown) {
            warnings.push({ sessionId, text: longRunWarningText(fresh.at(-1), { warnAfterMs, othersCount: fresh.length - 1 }) })
            sessionPatches[sessionId] = { longRunWarnedPids: [...warned, ...fresh.map((run) => run.pid)], lastLongRunWarnAt: now }
        } else if (warned.length !== previouslyWarned.length) {
            sessionPatches[sessionId] = { longRunWarnedPids: warned.length > 0 ? warned : undefined }
        }
    }
    return { sessionPatches, warnings }
}
