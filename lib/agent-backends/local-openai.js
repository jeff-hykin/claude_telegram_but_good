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

import { versionedImport } from "../version.js"

const { defineBackend } = await versionedImport("./spec.js", import.meta)
const { getConfigKey } = await versionedImport("../config-manager.js", import.meta)
const { pushFrame, spawnRunner, killRunner, readRunnerScreen } = await versionedImport("./runner-process.js", import.meta)

const RUNNER_JS = new URL("../../event-generators/agent-runner/runner.js", import.meta.url).pathname

function baseUrl() {
    return String(getConfigKey("local_model_base_url", "http://localhost:1234/v1")).replace(/\/+$/, "")
}

async function spawn(request) {
    return await spawnRunner(RUNNER_JS, request)
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
    return await killRunner(session)
}

async function readScreen({ session, height = 50 }) {
    return await readRunnerScreen(session, height)
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
