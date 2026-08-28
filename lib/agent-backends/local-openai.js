// ---------------------------------------------------------------------------
// lib/agent-backends/local-openai.js — a cbg session driven by a local
// OpenAI-compatible model server (LM Studio, serving Qwen).
//
// The second implementation of lib/agent-backends/spec.js, and the reason
// the spec exists. Where the Claude backend drives a TUI through a pty and
// reads the screen back, this one spawns event-generators/agent-runner/
// runner.js — a plain Deno process that speaks the session-side protocol
// directly. No dtach, no pty, no output scraping.
//
// That asymmetry is the whole design: the daemon↔session IPC protocol was
// already agent-neutral, so a backend that speaks it inherits the spinner,
// nudges, long tasks and the critic for free. The Claude-specific parts
// (screen rendering, keystroke injection, ESC-to-interrupt) turn out to be
// Claude's problem, not cbg's.
//
// Capability differences from Claude, and why:
//   rawInput / slashCommands / login — need a TUI. There isn't one, so
//       /raw, /compact and /login report "unsupported" rather than lying.
//   permissionPrompts — the runner runs its own tools directly; there is
//       no permission layer to prompt through yet.
//   screen — supported, but it renders the runner's transcript file rather
//       than a VT100 replay.
// ---------------------------------------------------------------------------

import { mkdirSync, readFileSync } from "node:fs"
import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { paths } = await versionedImport("../paths.js", import.meta)
const { defineBackend } = await versionedImport("./spec.js", import.meta)
const { writeIpcFrame } = await versionedImport("../ipc.js", import.meta)
const { getConfigKey } = await versionedImport("../config-manager.js", import.meta)

const RUNNER_JS = new URL("../../event-generators/agent-runner/runner.js", import.meta.url).pathname

function baseUrl() {
    return String(getConfigKey("local_model_base_url", "http://localhost:1234/v1")).replace(/\/+$/, "")
}

/**
 * Write one frame down the session's live IPC connection. Unlike the
 * Claude backend — which has no inbound channel and must type into a pty —
 * this is the whole outbound story for a local session.
 */
async function pushFrame(session, frame, label) {
    if (!session?._conn) {
        return { ok: false, detail: `session ${session?.id} is not connected` }
    }
    try {
        await writeIpcFrame(session._conn, frame)
        dbg("BACKEND-LOCAL", `${label} → ${session.id}`)
        return { ok: true }
    } catch (e) {
        dbg("BACKEND-LOCAL", `${label} failed for ${session.id}:`, e)
        return { ok: false, detail: e instanceof Error ? e.message : String(e) }
    }
}

async function spawn({ sessionId, title, cwd, topicName, prompt }) {
    if (!sessionId) {
        return { ok: false, detail: "missing sessionId" }
    }

    if (topicName) {
        try {
            mkdirSync(paths.topicDir(topicName), { recursive: true })
        } catch (e) {
            dbg("BACKEND-LOCAL", "topic dir mkdir failed:", e)
        }
    }

    const env = { ...Deno.env.toObject() }
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
            args: ["run", "-A", RUNNER_JS],
            env,
            clearEnv: true,
            stdin: "null",
            stdout: "null",
            stderr: "null",
        }).spawn()
        child.unref()
        dbg("BACKEND-LOCAL", `spawned runner for ${sessionId} (pid ${child.pid}, topic=${topicName ?? "-"})`)
        return { ok: true }
    } catch (e) {
        dbg("BACKEND-LOCAL", `runner spawn failed for ${sessionId}:`, e)
        return { ok: false, detail: `runner spawn failed: ${e instanceof Error ? e.message : String(e)}` }
    }
}

async function sendUserText({ session, text, kind }) {
    return await pushFrame(session, { type: "agent_input", text, kind: kind ?? "prompt" }, "agent_input")
}

async function sendFiles({ session, filePaths }) {
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
        return { ok: false, detail: "no filePaths given" }
    }
    const text = filePaths.map((path) => `[file: ${path}]`).join("\n")
    return await pushFrame(session, { type: "agent_input", text, kind: "files" }, "agent_input(files)")
}

async function interrupt({ session }) {
    return await pushFrame(session, { type: "agent_control", action: "interrupt" }, "interrupt")
}

async function kill({ session }) {
    const result = await pushFrame(session, { type: "agent_control", action: "kill" }, "kill")
    if (result.ok) {
        return result
    }
    // Not connected — fall back to the pid it registered with.
    if (!session?.pid) {
        return { ok: false, detail: `no connection and no pid for session ${session?.id}` }
    }
    try {
        Deno.kill(session.pid, "SIGTERM")
        return { ok: true }
    } catch (e) {
        dbg("BACKEND-LOCAL", `kill pid ${session.pid} failed:`, e)
        return { ok: false, detail: e instanceof Error ? e.message : String(e) }
    }
}

async function readScreen({ session, height = 50 }) {
    if (!session?.id) {
        return { ok: false, detail: "no session id" }
    }
    try {
        const raw = readFileSync(paths.localAgentLogFile(session.id), "utf8")
        const lines = raw.split("\n")
        return { ok: true, screen: lines.slice(-height).join("\n") }
    } catch (e) {
        dbg("BACKEND-LOCAL", `transcript read failed for ${session.id}:`, e)
        return { ok: false, detail: `no transcript yet for ${session.id}` }
    }
}

async function healthCheck() {
    const url = `${baseUrl()}/models`
    try {
        const response = await fetch(url, {
            headers: { authorization: `Bearer ${getConfigKey("local_model_api_key", "lm-studio")}` },
            signal: AbortSignal.timeout(5000),
        })
        if (!response.ok) {
            return { ok: false, detail: `${url} returned ${response.status}` }
        }
        const body = await response.json()
        const available = (body.data ?? []).map((entry) => entry.id)
        const wanted = getConfigKey("local_model", "qwen2.5-coder-32b-instruct")
        if (available.length > 0 && !available.includes(wanted)) {
            return { ok: false, detail: `model "${wanted}" is not loaded; available: ${available.join(", ")}` }
        }
        return { ok: true, detail: `${wanted} ready at ${baseUrl()}` }
    } catch (e) {
        return { ok: false, detail: `cannot reach ${url}: ${e instanceof Error ? e.message : String(e)}` }
    }
}

export const backend = defineBackend({
    name: "local",
    description: "A local OpenAI-compatible model (LM Studio / Qwen) driving cbg's own agent loop",
    capabilities: {
        rawInput: false,
        screen: true,
        slashCommands: false,
        login: false,
        permissionPrompts: false,
        interrupt: true,
    },
    spawn,
    sendUserText,
    sendFiles,
    interrupt,
    kill,
    readScreen,
    healthCheck,
})
