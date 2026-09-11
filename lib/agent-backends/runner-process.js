// ---------------------------------------------------------------------------
// lib/agent-backends/runner-process.js — the parts every runner-based
// backend shares.
//
// Two of the three backends (local-openai, codex) drive their session
// through a Deno process under event-generators/agent-runner/ rather than
// a pty. For those, the whole daemon side of lib/agent-backends/spec.js is
// the same four moves: spawn the runner with the session's env, push a
// frame down its live IPC connection, tail its transcript, kill it. Only
// healthCheck and the capability flags are actually backend-specific.
//
// The Claude backend deliberately does NOT use this — it has no runner,
// and typing keystrokes into a pty has nothing in common with any of it.
// ---------------------------------------------------------------------------

import { mkdirSync, readFileSync } from "node:fs"
import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { paths } = await versionedImport("../paths.js", import.meta)
const { writeIpcFrame } = await versionedImport("../ipc.js", import.meta)

/** Write one frame down the session's live IPC connection. */
export async function pushFrame(session, frame, label) {
    if (!session?._conn) {
        return { ok: false, detail: `session ${session?.id} is not connected` }
    }
    try {
        await writeIpcFrame(session._conn, frame)
        dbg("BACKEND-RUNNER", `${label} → ${session.id}`)
        return { ok: true }
    } catch (e) {
        dbg("BACKEND-RUNNER", `${label} failed for ${session.id}:`, e)
        return { ok: false, detail: e instanceof Error ? e.message : String(e) }
    }
}

/**
 * Launch a runner script for a new session.
 *
 * @param {string} runnerPath — absolute path to the runner's entry point
 * @param {object} request — the SpawnRequest from spec.js
 * @param {object} [extraEnv] — backend-specific env for the runner
 */
export async function spawnRunner(runnerPath, { sessionId, title, cwd, topicName, prompt }, extraEnv = {}) {
    if (!sessionId) {
        return { ok: false, detail: "missing sessionId" }
    }

    if (topicName) {
        try {
            mkdirSync(paths.topicDir(topicName), { recursive: true })
        } catch (e) {
            dbg("BACKEND-RUNNER", "topic dir mkdir failed:", e)
        }
    }

    const env = { ...Deno.env.toObject(), ...extraEnv }
    env.CBG_SESSION_ID = sessionId
    env.CBG_SESSION_CWD = cwd ?? Deno.env.get("HOME") ?? "/"
    if (title) { env.CBG_SESSION_TITLE = title }
    if (topicName) { env.CBG_TOPIC_NAME = topicName }
    if (prompt) { env.CBG_INITIAL_PROMPT = prompt }

    try {
        // Detached: the runner outlives this daemon, and reconnects on its
        // own if the daemon restarts underneath it. Its stdout/stderr go
        // nowhere useful — everything diagnostic goes to dbg() and to the
        // per-session transcript.
        const child = new Deno.Command("deno", {
            args: ["run", "-A", runnerPath],
            env,
            clearEnv: true,
            stdin: "null",
            stdout: "null",
            stderr: "null",
        }).spawn()
        child.unref()
        dbg("BACKEND-RUNNER", `spawned ${runnerPath} for ${sessionId} (pid ${child.pid}, topic=${topicName ?? "-"})`)
        return { ok: true }
    } catch (e) {
        dbg("BACKEND-RUNNER", `runner spawn failed for ${sessionId}:`, e)
        return { ok: false, detail: `runner spawn failed: ${e instanceof Error ? e.message : String(e)}` }
    }
}

/** Ask the runner to stop; fall back to SIGTERM if it isn't listening. */
export async function killRunner(session) {
    const result = await pushFrame(session, { type: "agent_control", action: "kill" }, "kill")
    if (result.ok) {
        return result
    }
    if (!session?.pid) {
        return { ok: false, detail: `no connection and no pid for session ${session?.id}` }
    }
    try {
        Deno.kill(session.pid, "SIGTERM")
        return { ok: true }
    } catch (e) {
        dbg("BACKEND-RUNNER", `kill pid ${session.pid} failed:`, e)
        return { ok: false, detail: e instanceof Error ? e.message : String(e) }
    }
}

/** /peek for a runner: the tail of its transcript, not a VT100 replay. */
export async function readRunnerScreen(session, height = 50) {
    if (!session?.id) {
        return { ok: false, detail: "no session id" }
    }
    try {
        const raw = readFileSync(paths.localAgentLogFile(session.id), "utf8")
        return { ok: true, screen: raw.split("\n").slice(-height).join("\n") }
    } catch (e) {
        dbg("BACKEND-RUNNER", `transcript read failed for ${session.id}:`, e)
        return { ok: false, detail: `no transcript yet for ${session.id}` }
    }
}

/**
 * Read back whatever the runner last recorded about its context window.
 * Absent file means the session has not completed a turn yet.
 */
export async function readRunnerUsage(session) {
    if (!session?.id) {
        return { ok: false, detail: "no session id" }
    }
    try {
        const usage = JSON.parse(readFileSync(paths.agentUsageFile(session.id), "utf8"))
        return { ok: true, ...usage }
    } catch (e) {
        dbg("BACKEND-RUNNER", `usage read failed for ${session.id}:`, e)
        return { ok: false, detail: `no context usage recorded for ${session.id} yet` }
    }
}
