#!/usr/bin/env -S deno run -A
// ---------------------------------------------------------------------------
// event-generators/agent-runner/codex-runner.js — a cbg session driven by
// OpenAI's Codex CLI.
//
// One process per session, spawned by lib/agent-backends/codex.js. It owns
// a `codex app-server` child and one Codex thread, and translates between
// two protocols that already exist:
//
//   codex app-server JSON-RPC  ←→  cbg's session-side IPC (spec.js HALF B)
//
// Unlike runner.js (the local-model runner) there is no agent loop here.
// Codex has its own: its own model, its own tools, its own sandbox, its
// own conversation history. Everything this file does is translation, and
// the interesting parts are the three places the two models disagree:
//
//   1. Codex has no "reply" concept. Its final assistant message is just
//      text. So the last agentMessage of a turn IS the Telegram reply —
//      the same decision Jeff made for the local backend, for the same
//      reason (a small/foreign agent will not reliably call a tool to
//      speak).
//   2. Codex reports work as `ThreadItem`s, cbg's spinner speaks Claude
//      tool names. lib/pure/codex-events.js translates.
//   3. Codex asks permission by sending a REQUEST and blocking. Nobody is
//      at the keyboard of a Telegram session, so an unanswered approval is
//      an infinite hang. Every approval request is answered, always.
//
// Env in:  CBG_SESSION_ID, CBG_SESSION_CWD, CBG_SESSION_TITLE,
//          CBG_TOPIC_NAME, CBG_INITIAL_PROMPT
// ---------------------------------------------------------------------------

import { appendFileSync, writeFileSync } from "node:fs"
import { paths } from "../../lib/paths.js"
import { dbg } from "../../lib/logging.js"
import { getConfigKey } from "../../lib/config-manager.js"
import { DaemonLink } from "./daemon-link.js"
import { CodexAppServer } from "./codex-client.js"
import {
    hookViewForItem,
    toolResponsePreview,
    agentTextFromTurn,
    usageFromTokenUsage,
    describeItem,
} from "../../lib/pure/codex-events.js"

const SESSION_ID = Deno.env.get("CBG_SESSION_ID")
if (!SESSION_ID) {
    console.error("codex-runner.js: CBG_SESSION_ID is required")
    Deno.exit(1)
}
const SESSION_CWD = Deno.env.get("CBG_SESSION_CWD") ?? Deno.env.get("HOME") ?? Deno.cwd()
const SESSION_TITLE = Deno.env.get("CBG_SESSION_TITLE") || null
const TOPIC_NAME = Deno.env.get("CBG_TOPIC_NAME") || null
const INITIAL_PROMPT = Deno.env.get("CBG_INITIAL_PROMPT") || null

const CODEX_BINARY = String(getConfigKey("codex_binary", "codex"))
const CODEX_MODEL = String(getConfigKey("codex_model", "") || "")
const CODEX_SANDBOX = String(getConfigKey("codex_sandbox", "workspace-write"))
const CODEX_APPROVAL_POLICY = String(getConfigKey("codex_approval_policy", "never"))
const TURN_TIMEOUT_MS = Number(getConfigKey("codex_turn_timeout_ms", 1_800_000))

const LOG_FILE = paths.localAgentLogFile(SESSION_ID)

function transcript(line) {
    try {
        appendFileSync(LOG_FILE, `${line}\n`)
    } catch (e) {
        dbg("CODEX-RUNNER", "transcript write failed:", e)
    }
}

/**
 * Codex's own system prompt already covers being a coding agent. This
 * covers only what Codex cannot know: that it is talking to a person over
 * Telegram, and that its closing message is what that person sees.
 */
function developerInstructions() {
    const memoryLine = TOPIC_NAME
        ? `\nYour persistent notes for this conversation live at ${paths.topicMemoryFile(TOPIC_NAME)}. Read it when you need context, and keep it up to date as you work.`
        : ""
    return [
        "You are reachable over Telegram through cbg. There is a real person on",
        "the other end of this conversation, not a terminal.",
        "",
        "The final message you write at the end of each turn is delivered to them",
        "verbatim. Nothing else you do is visible to them, so never end a turn",
        "silently and never end one with only a tool call. Keep that final message",
        "short and conversational — this is a chat window on a phone, not a report.",
        "",
        "Nobody can answer an approval prompt or a clarifying question mid-turn;",
        "questions only reach them once your turn ends.",
        memoryLine,
    ].join("\n")
}

// ── Session state ─────────────────────────────────────────────────────

let threadId = null
let currentTurnId = null
/** Item ids we emitted PreToolUse for, so PostToolUse can't fire unpaired. */
const spinning = new Set()
/** turn/completed can arrive both as a notification and as turn/start's result. */
const finishedTurns = new Set()
/**
 * The final_answer text seen streaming past, because the turn object is
 * not always carrying it: `turn/start`'s result and an interrupted turn
 * both come back with `itemsView: "notLoaded"` and no items at all.
 */
let finalAnswerText = ""
let lastInbound = null
let turnDone = null

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
        backend: "codex",
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
                interruptTurn()
            } else if (msg.action === "kill") {
                shutdown("killed by daemon")
            }
            return
        }
        dbg("CODEX-RUNNER", `ignoring daemon frame: ${msg.type}`)
    },
)

function interruptTurn() {
    if (!currentTurnId) {
        dbg("CODEX-RUNNER", "interrupt with no turn in flight")
        return
    }
    dbg("CODEX-RUNNER", `interrupting turn ${currentTurnId}`)
    transcript("[interrupt] requested")
    codex.request("turn/interrupt", { threadId, turnId: currentTurnId }, 30_000)
        .catch((e) => dbg("CODEX-RUNNER", "turn/interrupt failed:", e))
}

// ── Codex → cbg ───────────────────────────────────────────────────────

function onNotification(method, params) {
    // An interrupted command is abandoned, not killed: `sleep 45` still
    // reports 45 seconds later, long after its turn closed. Replaying it
    // would flash a spinner for a turn the user already saw end.
    if (params?.turnId && finishedTurns.has(params.turnId)) {
        return
    }
    switch (method) {
        case "turn/started":
            currentTurnId = params.turn?.id ?? currentTurnId
            return
        case "item/started": {
            const view = hookViewForItem(params.item)
            if (!view || !params.item?.id) { return }
            spinning.add(params.item.id)
            link.hook("PreToolUse", {
                tool_name: view.toolName,
                tool_use_id: params.item.id,
                tool_input: view.toolInput,
            })
            return
        }
        case "item/completed": {
            const item = params.item
            if (!item) { return }
            transcript(describeItem(item))
            if (item.type === "agentMessage" && item.phase === "final_answer" && item.text) {
                finalAnswerText = String(item.text).trim()
            }
            const view = hookViewForItem(item)
            if (!view || !item.id) { return }
            // An item can complete without ever starting (Codex emits some
            // items whole). Pair it up so the spinner isn't left running.
            if (!spinning.has(item.id)) {
                link.hook("PreToolUse", {
                    tool_name: view.toolName,
                    tool_use_id: item.id,
                    tool_input: view.toolInput,
                })
            }
            spinning.delete(item.id)
            link.hook("PostToolUse", {
                tool_name: view.toolName,
                tool_use_id: item.id,
                tool_input: view.toolInput,
                tool_response: toolResponsePreview(item),
            })
            return
        }
        case "thread/tokenUsage/updated":
            recordUsage(params.tokenUsage)
            return
        case "turn/completed":
            finishTurn(params.turn)
            return
        case "error": {
            const message = params.error?.message ?? "unknown error"
            transcript(`[error] ${message}${params.willRetry ? " (retrying)" : ""}`)
            dbg("CODEX-RUNNER", `codex error: ${message}`)
            return
        }
        default:
            return
    }
}

/**
 * Codex blocks on approval requests, so the only unacceptable answer is
 * no answer. `codex_approval_policy: never` normally means these never
 * arrive; if one does anyway, it is because Codex wants to step outside
 * the sandbox, and the sandbox is the boundary we actually chose.
 *
 * Each request family speaks a different decline vocabulary, and a value
 * from the wrong one is accepted silently and treated as a rejection —
 * which looks identical to this until you want to start ACCEPTING.
 */
function onServerRequest(id, method, params) {
    transcript(`[approval] ${method} — declining (no human at the keyboard)`)
    dbg("CODEX-RUNNER", `declining approval request ${method}`, params?.command ?? "")
    switch (method) {
        case "item/commandExecution/requestApproval":
        case "item/fileChange/requestApproval":
        case "item/permissions/requestApproval":
            codex.respond(id, { decision: "decline" })
            return
        // Legacy pre-`item/*` approvals, still reachable on older codex.
        case "execCommandApproval":
        case "applyPatchApproval":
            codex.respond(id, { decision: "abort" })
            return
        case "mcpServer/elicitation/request":
            codex.respond(id, { action: "decline" })
            return
        default:
            // An unknown request still has to be answered or the turn wedges.
            codex.respond(id, {})
            return
    }
}

function recordUsage(tokenUsage) {
    if (!tokenUsage) { return }
    try {
        writeFileSync(paths.agentUsageFile(SESSION_ID), JSON.stringify(usageFromTokenUsage(tokenUsage)))
    } catch (e) {
        dbg("CODEX-RUNNER", "usage write failed:", e)
    }
}

async function finishTurn(turn) {
    if (turn?.id) {
        if (finishedTurns.has(turn.id)) { return }
        finishedTurns.add(turn.id)
    }

    for (const itemId of spinning) {
        link.hook("PostToolUse", {
            tool_name: "Bash",
            tool_use_id: itemId,
            tool_input: {},
            tool_response: { error: "turn ended before this finished" },
        })
    }
    spinning.clear()

    let text = agentTextFromTurn(turn) || finalAnswerText
    finalAnswerText = ""
    if (turn?.error?.message) {
        text = text || `Codex turn failed: ${turn.error.message}`
    }
    if (text && lastInbound?.chatId) {
        await deliverReply(text)
    } else if (!text) {
        transcript("[warn] turn produced no assistant message")
    }

    currentTurnId = null
    link.hook("Stop")
    transcript("[stop]")
    if (turnDone) {
        turnDone()
        turnDone = null
    }
}

/**
 * The daemon can REJECT a reply (the /tldr length cap returns isError and
 * nothing reaches the user). Swallowing that is the exact silent-drop bug
 * this backend has to avoid, so hand the rejection back to Codex once and
 * let it rewrite. Once, not in a loop: the rewrite is a whole extra turn.
 */
async function deliverReply(text, isRewrite = false) {
    transcript(`[reply] ${text.slice(0, 400)}`)
    const result = await link.callTool("reply", { chat_id: lastInbound.chatId, text })
    if (!result?.isError) { return }
    const detail = result.content?.map((part) => part.text).join("\n") || "rejected with no detail"
    transcript(`[reply-rejected] ${detail.slice(0, 300)}`)
    if (isRewrite) {
        dbg("CODEX-RUNNER", "rewritten reply was rejected too, giving up")
        return
    }
    enqueueInput(`[message system] Your last answer was NOT delivered to the user: ${detail}. Send a shorter one.`, null)
}

// ── The turn loop ─────────────────────────────────────────────────────

const codex = new CodexAppServer({
    binary: CODEX_BINARY,
    cwd: SESSION_CWD,
    env: Deno.env.toObject(),
    onNotification,
    onServerRequest,
    onStderr: (line) => transcript(`[codex-stderr] ${line}`),
    onExit: () => shutdown("codex app-server exited"),
})

async function startThread() {
    await codex.request("initialize", {
        clientInfo: { name: "cbg", title: "cbg", version: String(globalThis.cbgVersion ?? "1") },
    }, 60_000)
    codex.notify("initialized")
    const params = {
        cwd: SESSION_CWD,
        sandbox: CODEX_SANDBOX,
        approvalPolicy: CODEX_APPROVAL_POLICY,
        developerInstructions: developerInstructions(),
    }
    if (CODEX_MODEL) {
        params.model = CODEX_MODEL
    }
    const started = await codex.request("thread/start", params, 60_000)
    threadId = started?.thread?.id
    if (!threadId) {
        throw new Error(`thread/start returned no thread id: ${JSON.stringify(started).slice(0, 300)}`)
    }
    const model = started.model || CODEX_MODEL || "default"
    const sandbox = started.sandbox?.type || CODEX_SANDBOX
    transcript(`[thread] ${threadId} model=${model} sandbox=${sandbox}`)
}

async function runTurn(text) {
    const completed = new Promise((resolve) => { turnDone = resolve })
    let result
    try {
        result = await codex.request("turn/start", {
            threadId,
            input: [{ type: "text", text }],
        }, TURN_TIMEOUT_MS)
    } catch (e) {
        const detail = e instanceof Error ? e.message : String(e)
        dbg("CODEX-RUNNER", "turn/start failed:", e)
        transcript(`[error] ${detail}`)
        turnDone = null
        if (lastInbound?.chatId) {
            await link.callTool("reply", { chat_id: lastInbound.chatId, text: `Codex error: ${detail}` })
        }
        link.hook("Stop")
        return
    }
    // turn/start may resolve with the finished turn, or immediately with an
    // in-flight one and the real end arrives as turn/completed. finishTurn
    // dedupes on turn id, so taking whichever lands first is safe.
    if (result?.turn?.status && result.turn.status !== "inProgress") {
        await finishTurn(result.turn)
    } else {
        currentTurnId = result?.turn?.id ?? currentTurnId
        await completed
    }
}

async function mainLoop() {
    while (true) {
        if (inputQueue.length === 0) {
            await new Promise((resolve) => { wakeUp = resolve })
            continue
        }
        // Drain everything queued into one turn — three messages that
        // arrived while Codex was busy should be seen together.
        const batch = inputQueue.splice(0, inputQueue.length).join("\n\n")
        try {
            await runTurn(batch)
        } catch (e) {
            dbg("CODEX-RUNNER", "turn threw:", e)
            transcript(`[error] turn threw: ${e instanceof Error ? e.message : String(e)}`)
            link.hook("Stop")
        }
    }
}

function shutdown(reason) {
    dbg("CODEX-RUNNER", `shutting down: ${reason}`)
    transcript(`[exit] ${reason}`)
    codex.close()
    link.shutdown(reason)
    Deno.exit(0)
}

for (const sig of ["SIGINT", "SIGTERM"]) {
    try {
        Deno.addSignalListener(sig, () => shutdown(sig))
    } catch (e) {
        dbg("CODEX-RUNNER", `signal listener for ${sig} failed:`, e)
    }
}

transcript(`[start] session=${SESSION_ID} cwd=${SESSION_CWD} binary=${CODEX_BINARY}`)
await link.connect()
try {
    await codex.start()
    await startThread()
} catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    transcript(`[fatal] could not start codex: ${detail}`)
    dbg("CODEX-RUNNER", "startup failed:", e)
    shutdown(`codex startup failed: ${detail}`)
}
if (INITIAL_PROMPT) {
    enqueueInput(INITIAL_PROMPT, null)
}
await mainLoop()
