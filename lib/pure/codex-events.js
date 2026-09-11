// ---------------------------------------------------------------------------
// lib/pure/codex-events.js — translate Codex app-server thread items into
// the shapes cbg already knows how to render.
//
// Pure and dependency-free so it can be unit-tested without a live Codex
// process, which matters: this is the layer that decides what the Telegram
// spinner says, and getting it wrong is invisible until a user is watching.
//
// Two vocabularies meet here. Codex emits `ThreadItem`s discriminated on
// `type` (commandExecution, fileChange, mcpToolCall, agentMessage, ...).
// cbg's spinner formatter (lib/pure/hook-format.js) only knows Claude
// Code's tool names (Bash, Edit, Write, Read, WebSearch, ...). Rather than
// teach the formatter a third vocabulary, we translate at the edge — the
// same trick event-generators/agent-runner/tools.js plays for the local
// backend.
// ---------------------------------------------------------------------------

/** Items that are conversation, not action — no spinner, no hook frames. */
const NON_TOOL_ITEM_TYPES = new Set([
    "userMessage",
    "agentMessage",
    "reasoning",
    "hookPrompt",
    "contextCompaction",
    "enteredReviewMode",
    "exitedReviewMode",
])

/**
 * The Claude-flavored view of a Codex thread item, for the spinner.
 * Returns null for items that aren't tool activity, so the caller can skip
 * emitting PreToolUse/PostToolUse for them.
 *
 * @returns {{toolName: string, toolInput: object} | null}
 */
export function hookViewForItem(item) {
    if (!item?.type || NON_TOOL_ITEM_TYPES.has(item.type)) {
        return null
    }
    switch (item.type) {
        case "commandExecution":
            return { toolName: "Bash", toolInput: { command: item.command ?? "" } }
        case "fileChange": {
            const changes = Array.isArray(item.changes) ? item.changes : []
            const first = changes[0]
            // A single Codex patch can touch several files; the spinner has
            // room for one path, so name the first and count the rest.
            const toolName = first?.kind?.type === "add" ? "Write" : "Edit"
            const toolInput = { file_path: first?.path ?? "(no path)" }
            if (changes.length > 1) {
                toolInput.file_path = `${toolInput.file_path} (+${changes.length - 1} more)`
            }
            return { toolName, toolInput }
        }
        case "mcpToolCall":
            return {
                toolName: `mcp__${item.server ?? "unknown"}__${item.tool ?? "unknown"}`,
                toolInput: item.arguments ?? {},
            }
        case "dynamicToolCall":
            return { toolName: item.tool ?? "tool", toolInput: item.arguments ?? {} }
        case "webSearch":
            return { toolName: "WebSearch", toolInput: { query: item.query ?? "" } }
        case "imageView":
            return { toolName: "Read", toolInput: { file_path: item.path ?? "" } }
        case "plan":
            return { toolName: "TodoWrite", toolInput: { todos: item.text ?? "" } }
        case "sleep":
            return { toolName: "Bash", toolInput: { command: `sleep ${(item.durationMs ?? 0) / 1000}` } }
        default:
            return { toolName: item.type, toolInput: {} }
    }
}

/**
 * The `tool_response` half of the hook pair. Kept small on purpose: the
 * daemon truncates the response JSON at 300 chars and a preview cut
 * mid-JSON renders as nothing at all.
 */
export function toolResponsePreview(item) {
    const failed = item?.status === "failed" || item?.status === "declined" ||
        (typeof item?.exitCode === "number" && item.exitCode !== 0)
    if (item?.type === "commandExecution") {
        const output = String(item.aggregatedOutput ?? "").slice(0, 150)
        return failed ? { error: `exit ${item.exitCode}: ${output}` } : { stdout: output }
    }
    if (item?.type === "fileChange") {
        const changes = Array.isArray(item.changes) ? item.changes : []
        const summary = changes.map((change) => `${change.kind?.type ?? "update"} ${change.path}`).join(", ")
        return failed ? { error: summary.slice(0, 150) } : { output: summary.slice(0, 150) }
    }
    if (item?.type === "mcpToolCall" && item.error) {
        return { error: String(item.error.message ?? JSON.stringify(item.error)).slice(0, 150) }
    }
    return failed ? { error: `status: ${item?.status}` } : { output: `status: ${item?.status ?? "completed"}` }
}

/**
 * The text Codex meant for the user.
 *
 * A turn emits several agentMessages: `phase: "commentary"` ones are
 * preamble the model narrates while it works, and exactly one
 * `phase: "final_answer"` is the answer. Delivering a commentary message
 * as the reply sends the user "I'll check that file" and never the
 * result, so the phase is what we key on — falling back to the last
 * message only if nothing is labelled.
 */
export function agentTextFromTurn(turn) {
    const items = Array.isArray(turn?.items) ? turn.items : []
    const messages = items.filter((item) => item?.type === "agentMessage" && item.text)
    const final = messages.filter((item) => item.phase === "final_answer")
    const chosen = final.length > 0 ? final[final.length - 1] : messages[messages.length - 1]
    return chosen ? String(chosen.text).trim() : ""
}

/**
 * Context accounting for /tokens.
 *
 * `last` is the most recent request's usage, which is what actually
 * describes the window right now — `total` is a cumulative bill across the
 * whole thread and would climb past the context limit and stay there.
 * inputTokens is the whole prompt (cachedInputTokens is a subset of it,
 * not an addition), plus the reply that will be in the next prompt.
 */
export function usageFromTokenUsage(tokenUsage) {
    const last = tokenUsage?.last ?? {}
    const tokens = Number(last.inputTokens ?? 0) + Number(last.outputTokens ?? 0)
    const limit = Number(tokenUsage?.modelContextWindow ?? 0) || null
    return {
        tokens,
        limit,
        percentUsed: limit ? Math.round((tokens / limit) * 100) : null,
    }
}

/** One line for the session transcript, which is what /peek renders. */
export function describeItem(item) {
    switch (item?.type) {
        case "agentMessage":
            return `[assistant] ${item.text ?? ""}`
        case "reasoning":
            return `[thinking] ${(item.summary ?? item.content ?? "").toString().slice(0, 400)}`
        case "commandExecution":
            return `[bash] ${item.command ?? ""}${item.exitCode == null ? "" : ` (exit ${item.exitCode})`}`
        case "fileChange":
            return `[edit] ${(item.changes ?? []).map((change) => change.path).join(", ")}`
        case "mcpToolCall":
            return `[mcp] ${item.server}/${item.tool}`
        case "webSearch":
            return `[search] ${item.query ?? ""}`
        case "plan":
            return `[plan] ${item.text ?? ""}`
        default:
            return `[${item?.type ?? "item"}]`
    }
}
