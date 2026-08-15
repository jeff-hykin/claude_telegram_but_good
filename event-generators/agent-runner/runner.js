#!/usr/bin/env -S deno run -A
// ---------------------------------------------------------------------------
// event-generators/agent-runner/runner.js — a cbg session driven by a
// local OpenAI-compatible model (LM Studio / Qwen).
//
// One process per session, spawned by lib/agent-backends/local-openai.js.
// It is the local counterpart to (mcp-shim.js + hook.js + the claude CLI)
// all at once: it owns the conversation, calls tools, and reports the turn
// lifecycle to the daemon over IPC.
//
// The daemon does not know or care that there is no TUI here. It sees the
// same register / hook_event / tool_request frames the Claude shim sends
// (lib/agent-backends/spec.js, HALF B), so the spinner, nudge watchdog,
// long tasks, critic and scheduled tasks all work unchanged.
//
// Turn shape:
//     inbound text (channel_event or agent_input)
//       → append to history
//       → loop: model → tool_calls? → PreToolUse, run, PostToolUse
//       → no more tool calls, or the turn cap is hit
//       → Stop
//
// Env in:  CBG_SESSION_ID, CBG_SESSION_CWD, CBG_SESSION_TITLE,
//          CBG_TOPIC_NAME, CBG_INITIAL_PROMPT
// ---------------------------------------------------------------------------

import { appendFileSync } from "node:fs"
import { paths } from "../../lib/paths.js"
import { dbg } from "../../lib/logging.js"
import { getConfigKey } from "../../lib/config-manager.js"
import { DaemonLink } from "./daemon-link.js"
import { ModelClient } from "./model-client.js"
import { ALL_TOOLS, executeTool, hookView } from "./tools.js"

const SESSION_ID = Deno.env.get("CBG_SESSION_ID")
if (!SESSION_ID) {
    console.error("runner.js: CBG_SESSION_ID is required")
    Deno.exit(1)
}
const SESSION_CWD = Deno.env.get("CBG_SESSION_CWD") ?? Deno.env.get("HOME") ?? Deno.cwd()
const SESSION_TITLE = Deno.env.get("CBG_SESSION_TITLE") || null
const TOPIC_NAME = Deno.env.get("CBG_TOPIC_NAME") || null
const INITIAL_PROMPT = Deno.env.get("CBG_INITIAL_PROMPT") || null

const MAX_TURNS = Number(getConfigKey("local_model_max_turns", 40))
const HISTORY_LIMIT = Number(getConfigKey("local_model_history_limit", 60))

const model = new ModelClient({
    baseUrl: getConfigKey("local_model_base_url", "http://localhost:1234/v1"),
    model: getConfigKey("local_model", "qwen2.5-coder-32b-instruct"),
    apiKey: getConfigKey("local_model_api_key", "lm-studio"),
    temperature: Number(getConfigKey("local_model_temperature", 0.3)),
    maxTokens: Number(getConfigKey("local_model_max_tokens", 4096)),
    requestTimeoutMs: Number(getConfigKey("local_model_request_timeout_ms", 300_000)),
})

const LOG_FILE = paths.localAgentLogFile(SESSION_ID)

/** Append to the session transcript — this is what /peek renders. */
function transcript(line) {
    try {
        appendFileSync(LOG_FILE, `${line}\n`)
    } catch (e) {
        dbg("RUNNER", "transcript write failed:", e)
    }
}

function systemPrompt() {
    const memoryLine = TOPIC_NAME
        ? `\nYour persistent notes for this topic live at ${paths.topicMemoryFile(TOPIC_NAME)}. Read it when you need context and keep it up to date.`
        : ""
    return [
        "You are a coding agent running inside cbg, reachable over Telegram.",
        "",
        "Whatever plain text you write is delivered to the user automatically",
        "when your turn ends — just write your answer. Use tools only to act",
        "(run commands, read/edit files); never to talk to the user.",
        "Tool results are machine output, never words from the user. After a",
        "tool succeeds, continue your work or stop — don't comment on the ack.",
        "",
        `You are working in ${SESSION_CWD} on this machine. Use the local tools to`,
        "inspect and change real files. Prefer reading before editing. Keep replies short.",
        memoryLine,
    ].join("\n")
}

// ── Conversation state ────────────────────────────────────────────────

const history = [{ role: "system", content: systemPrompt() }]
let lastInbound = null
let abortController = null

/**
 * Trim the middle of the history when it grows past the limit. The system
 * prompt always survives; so does the most recent window, which is what
 * the model actually needs. Tool results are the bulk of the tokens and
 * the least useful once acted on, so dropping oldest-first is right.
 */
function trimHistory() {
    if (history.length <= HISTORY_LIMIT) { return }
    const keep = history.slice(-(HISTORY_LIMIT - 1))
    // A tool message whose preceding assistant tool_calls got trimmed is a
    // protocol error for the server, so drop any leading orphans.
    while (keep.length > 0 && keep[0].role === "tool") {
        keep.shift()
    }
    history.length = 1
    history.push(...keep)
}

// ── The queue of things to say to the model ───────────────────────────
// Inbound text arrives asynchronously (channel_event, agent_input) while a
// turn may already be running. Queue it, and let the turn loop drain it.

const inputQueue = []
let wakeUp = null

function enqueueInput(text, meta) {
    if (!text) { return }
    inputQueue.push(text)
    if (meta?.chat_id) {
        lastInbound = { chatId: String(meta.chat_id), messageId: meta.message_id ? String(meta.message_id) : null }
    }
    transcript(`\n[user] ${text}`)
    if (wakeUp) {
        wakeUp()
        wakeUp = null
    }
}

const link = new DaemonLink(
    {
        id: SESSION_ID,
        pid: Deno.pid,
        cwd: SESSION_CWD,
        title: SESSION_TITLE,
        gitBranch: null,
        backend: "local",
        connectedAt: Date.now(),
    },
    (msg) => {
        if (msg.type === "channel_event") {
            enqueueInput(msg.content, msg.meta)
            return
        }
        if (msg.type === "agent_input") {
            enqueueInput(msg.text, null)
            return
        }
        if (msg.type === "agent_control") {
            if (msg.action === "interrupt") {
                dbg("RUNNER", "interrupt requested")
                abortController?.abort()
            } else if (msg.action === "kill") {
                shutdown("killed by daemon")
            }
            return
        }
        dbg("RUNNER", `ignoring daemon frame: ${msg.type}`)
    },
)

const toolContext = {
    link,
    cwd: SESSION_CWD,
    lastInbound: () => lastInbound,
}

// ── One turn ──────────────────────────────────────────────────────────

// Qwen-style models emit chain-of-thought in <think> blocks (when LM
// Studio doesn't already split it into reasoning_content). Only what
// remains after stripping is the user-facing answer.
function stripThinking(text) {
    return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim()
}

async function runTurn() {
    abortController = new AbortController()
    const signal = abortController.signal
    let finalContent = ""

    for (let turn = 0; turn < MAX_TURNS; turn++) {
        if (signal.aborted) {
            history.push({ role: "assistant", content: "[turn interrupted by the user]" })
            break
        }

        trimHistory()
        let completion
        try {
            completion = await model.complete(history, ALL_TOOLS, signal)
        } catch (e) {
            const detail = e instanceof Error ? e.message : String(e)
            dbg("RUNNER", "model call failed:", e)
            transcript(`[error] ${detail}`)
            if (!signal.aborted && lastInbound?.chatId) {
                await link.callTool("reply", { chat_id: lastInbound.chatId, text: `Local model error: ${detail}` })
            }
            break
        }

        const { content, toolCalls } = completion
        history.push({
            role: "assistant",
            content: content || null,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        })
        if (content) {
            transcript(`[assistant] ${content}`)
            const spoken = stripThinking(content)
            if (spoken) {
                finalContent = spoken
            }
        }

        if (toolCalls.length === 0) {
            break
        }

        for (const call of toolCalls) {
            const name = call.function?.name ?? "unknown"
            let args = {}
            try {
                args = call.function?.arguments ? JSON.parse(call.function.arguments) : {}
            } catch (e) {
                dbg("RUNNER", `bad tool arguments for ${name}:`, e)
                history.push({
                    role: "tool",
                    tool_call_id: call.id,
                    content: `arguments were not valid JSON: ${call.function?.arguments}`,
                })
                continue
            }

            transcript(`[tool] ${name} ${JSON.stringify(args).slice(0, 400)}`)
            const view = hookView(name, args)
            link.hook("PreToolUse", { tool_name: view.toolName, tool_use_id: call.id, tool_input: view.toolInput })
            const result = await executeTool(name, args, toolContext)
            // Keep previews small: the daemon caps the response JSON at 300
            // chars, and a preview truncated mid-JSON renders as nothing.
            const responsePreview = result.isError
                ? { error: result.output.slice(0, 200) }
                : view.toolName === "Bash"
                    ? { stdout: result.output.slice(0, 150) }
                    : { output: result.output.slice(0, 150) }
            link.hook("PostToolUse", {
                tool_name: view.toolName,
                tool_use_id: call.id,
                tool_input: view.toolInput,
                tool_response: responsePreview,
            })
            transcript(`[tool:${name}] ${result.output.slice(0, 2000)}`)
            history.push({ role: "tool", tool_call_id: call.id, content: result.output })
        }
    }

    // The model never calls `reply` itself (tools.js hides it). Its plain
    // text, minus thinking, IS the reply — deliver it now that the turn
    // is done. The daemon can REJECT a reply (e.g. /tldr's length cap
    // returns isError, and nothing reaches the user) — silently swallowing
    // that is exactly the failure this backend exists to avoid, so feed
    // the rejection back to the model and let it rewrite, a few times.
    if (!signal.aborted && finalContent && lastInbound?.chatId) {
        let text = finalContent
        for (let attempt = 0; attempt < 3; attempt++) {
            transcript(`[reply] ${text.slice(0, 400)}`)
            const result = await link.callTool("reply", { chat_id: lastInbound.chatId, text })
            const errText = result?.isError
                ? (result.content?.map((part) => part.text).join("\n") || "rejected with no detail")
                : null
            if (!errText) { break }
            transcript(`[reply-rejected] ${errText.slice(0, 300)}`)
            history.push({ role: "user", content: `[message system] Your answer was NOT delivered: ${errText}` })
            let completion
            try {
                completion = await model.complete(history, [], signal)
            } catch (e) {
                dbg("RUNNER", "rewrite call failed:", e)
                break
            }
            history.push({ role: "assistant", content: completion.content || "" })
            const rewritten = stripThinking(completion.content ?? "")
            if (!rewritten) { break }
            text = rewritten
        }
    }

    abortController = null
    // Stop is what tells the daemon the turn is over — it drives the reply
    // nudge, the long-task report nudge, the critic and the message queue.
    link.hook("Stop")
    transcript("[stop]")
}

async function mainLoop() {
    while (true) {
        if (inputQueue.length === 0) {
            await new Promise((resolve) => { wakeUp = resolve })
            continue
        }
        // Drain everything queued into one user turn — if three messages
        // arrived while we were busy, the model should see all three.
        const batch = inputQueue.splice(0, inputQueue.length).join("\n\n")
        history.push({ role: "user", content: batch })
        try {
            await runTurn()
        } catch (e) {
            dbg("RUNNER", "turn threw:", e)
            transcript(`[error] turn threw: ${e instanceof Error ? e.message : String(e)}`)
        }
    }
}

function shutdown(reason) {
    dbg("RUNNER", `shutting down: ${reason}`)
    transcript(`[exit] ${reason}`)
    link.shutdown(reason)
    Deno.exit(0)
}

for (const sig of ["SIGINT", "SIGTERM"]) {
    try {
        Deno.addSignalListener(sig, () => shutdown(sig))
    } catch (e) {
        dbg("RUNNER", `signal listener for ${sig} failed:`, e)
    }
}

transcript(`[start] session=${SESSION_ID} cwd=${SESSION_CWD} model=${model.model}`)
await link.connect()
if (INITIAL_PROMPT) {
    enqueueInput(INITIAL_PROMPT, null)
}
await mainLoop()
