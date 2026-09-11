// ---------------------------------------------------------------------------
// lib/agent-backends/codex.js — a cbg session driven by OpenAI's Codex CLI.
//
// The third implementation of lib/agent-backends/spec.js, and the one that
// shows the spec was worth writing: Codex is neither of the other two. It
// is not a TUI to be scraped (like Claude Code) and it is not a raw
// chat-completions endpoint we run our own agent loop against (like the
// local backend). It is a whole agent that already owns its model, its
// tools, its sandbox and its conversation history — so cbg's job here is
// pure translation, not orchestration.
//
// The translation happens in event-generators/agent-runner/codex-runner.js,
// which speaks `codex app-server`'s stdio JSON-RPC on one side and the
// session-side wire protocol (spec.js, HALF B) on the other:
//
//     codex app-server                        cbg daemon
//     ────────────────                        ──────────
//     item/started        ──────────────────► hook_event PreToolUse
//     item/completed      ──────────────────► hook_event PostToolUse
//     turn/completed      ──────────────────► reply + hook_event Stop
//     thread/tokenUsage/updated ────────────► agent-usage-<id>.json (/tokens)
//     turn/start          ◄────────────────── channel_event / agent_input
//     turn/interrupt      ◄────────────────── agent_control interrupt
//
// Capability differences from Claude, and why:
//   rawInput / slashCommands / login — all need Codex's TUI, which we
//       deliberately do not run. `codex login` is a terminal flow the user
//       runs once themselves; /login here would have nothing to drive.
//   permissionPrompts — Codex CAN ask for approval, but a Telegram session
//       has nobody at the keyboard to answer, so the runner starts threads
//       with an approval policy (default: never) and lets the sandbox be
//       the real boundary. See `codex_approval_policy`.
//   screen — the runner's transcript, same as the local backend.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { defineBackend } = await versionedImport("./spec.js", import.meta)
const { getConfigKey } = await versionedImport("../config-manager.js", import.meta)
const {
    pushFrame,
    spawnRunner,
    killRunner,
    readRunnerScreen,
    readRunnerUsage,
} = await versionedImport("./runner-process.js", import.meta)

const RUNNER_JS = new URL("../../event-generators/agent-runner/codex-runner.js", import.meta.url).pathname

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

async function contextUsage({ session }) {
    return await readRunnerUsage(session)
}

/**
 * Both halves of "can this backend actually run": the binary exists, and
 * it has credentials. `codex login status` covers the second — without it
 * a spawn succeeds and then every turn fails at the API call, which is a
 * much worse place to find out.
 */
async function healthCheck() {
    const binary = String(getConfigKey("codex_binary", "codex"))
    try {
        const status = await new Deno.Command(binary, {
            args: ["login", "status"],
            stdout: "piped",
            stderr: "piped",
        }).output()
        // `codex login status` reports on stderr even when it succeeds.
        const decoder = new TextDecoder()
        const text = `${decoder.decode(status.stdout)}${decoder.decode(status.stderr)}`.trim()
        if (!status.success) {
            return { ok: false, detail: `${binary} is installed but not logged in: ${text || "run `codex login`"}` }
        }
        return { ok: true, detail: text }
    } catch (e) {
        return { ok: false, detail: `cannot run "${binary}": ${e instanceof Error ? e.message : String(e)}` }
    }
}

export const backend = defineBackend({
    name: "codex",
    description: "OpenAI's Codex CLI, driven through its app-server JSON-RPC protocol",
    capabilities: {
        rawInput: false,
        screen: true,
        slashCommands: false,
        login: false,
        permissionPrompts: false,
        interrupt: true,
        contextUsage: true,
    },
    spawn,
    sendUserText,
    sendFiles,
    interrupt,
    kill,
    readScreen,
    contextUsage,
    healthCheck,
})
