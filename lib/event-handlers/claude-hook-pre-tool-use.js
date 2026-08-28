// ---------------------------------------------------------------------------
// claude_hook_pre_tool_use handler.
//
// Fired when Claude is about to call a tool. For v1 we:
//   1. Bail if we can't attribute the event to a session.
//   2. Bail if the session is not the currently-focused one (we only care
//      about status updates for the focused session).
//   3. Update `lastActive` on the session so freshness tracking works.
//   4. Append a cold-storage entry on the "hooks" stream for later audit.
//
// Telegram output is intentionally NOT emitted here yet. Deciding which
// chat(s) to send to requires access-list state that isn't wired into the
// event-loop core yet; that work is tracked as a v2 feature. For now the
// formatter is imported and invoked purely so any parse errors surface in
// logs and so we still gate cold-storage writes on "would this render?".
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { formatPreToolUse } = await versionedImport("../pure/hook-format.js", import.meta)
const { toolHookAction } = await versionedImport("../memory-hooks.js", import.meta)

// Reason fed back to the agent when we deny AskUserQuestion. Shown to the
// model (permissionDecisionReason), so it's written as direct guidance.
const ASK_USER_QUESTION_DENY_REASON =
    "AskUserQuestion is disabled in this session: it's driven through a chat channel (Telegram/Discord), so there is no interactive terminal to answer it and the call would hang forever. " +
    "Do NOT use AskUserQuestion here. Instead, ask the user with the `reply` tool — write your question, and if you have choices, list them as a short numbered list — then STOP and wait. " +
    "The user's answer arrives as a normal message you can act on."

function truncate(s, max) {
    if (typeof s !== "string") { return s }
    if (s.length <= max) { return s }
    return s.slice(0, max - 3) + "..."
}

export default function handle(event, core) {
    // AskUserQuestion can't be answered in a channel-driven session (no human
    // at a keyboard), so it hangs the agent forever. hook.js blocks on a
    // decision frame for THIS tool, so we ALWAYS respond here — even for
    // unregistered sessions (so a plain interactive `claude` gets an immediate
    // allow rather than waiting out the hook's read timeout). Deny only when
    // the claudePid resolved to a registered cbg session; otherwise allow so
    // interactive terminals keep AskUserQuestion working.
    if (event.toolName === "AskUserQuestion") {
        const isCbgSession = !!(event.sessionId && core.chatSessions?.[event.sessionId])
        dbg("HOOK-PRE", `AskUserQuestion → ${isCbgSession ? "deny" : "allow"} (sessionId=${event.sessionId ?? "none"})`)
        return {
            stateChanges: isCbgSession
                ? { chatSessions: { [event.sessionId]: { lastActive: event.ts } } }
                : {},
            effects: [
                {
                    type: "ipc_respond",
                    conn: event._conn,
                    closeAfter: true,
                    message: isCbgSession
                        ? { type: "hook_decision", deny: true, reason: ASK_USER_QUESTION_DENY_REASON }
                        : { type: "hook_decision", deny: false },
                },
            ],
        }
    }

    if (!event.sessionId) {
        dbg("HOOK-PRE", "no sessionId (claudePid unresolved) — skipping")
        return { stateChanges: {}, effects: [] }
    }

    const session = core.chatSessions?.[event.sessionId]
    if (!session) {
        dbg("HOOK-PRE", `no session found for ${event.sessionId} — skipping`)
        return { stateChanges: {}, effects: [] }
    }

    // Claude stamps every hook payload with this session's transcript path,
    // and tool hooks fire long before the turn's Stop does — so recording it
    // here is what makes /tokens answerable mid-turn rather than only after
    // the agent goes idle. See lib/pure/context-usage.js.
    const transcriptPatch = typeof event.transcriptPath === "string" && event.transcriptPath !== session.transcriptPath
        ? { transcriptPath: event.transcriptPath }
        : {}

    // Translate camelCase event fields into the snake_case shape the
    // formatter expects, then render. A null return means "hide this tool".
    const rendered = formatPreToolUse({
        tool_name: event.toolName,
        input_preview: event.inputPreview,
        output_preview: event.outputPreview,
        is_error: event.isError,
    })
    if (rendered === null) {
        dbg("HOOK-PRE", `formatter hid tool ${event.toolName} — skipping`)
        return {
            stateChanges: {
                chatSessions: {
                    [event.sessionId]: { lastActive: event.ts, ...transcriptPatch },
                },
            },
            effects: [],
        }
    }

    dbg("HOOK-PRE", `${event.sessionId} ${event.toolName}`)

    // Memory hooks (lib/memory-hooks.js): a standing note about whatever
    // this tool call touches gets nudged into the session. Hidden tools are
    // deliberately past us already — the channel tools have their own check
    // in claude-channel.js and would otherwise fire twice.
    const memoryHooks = toolHookAction(session, event.sessionId, [event.toolName, event.inputPreview])

    // No spinner append effect emitted — the built-in spinner policy
    // in main-event-processor.js detects this event type and calls
    // appendSpinnerItem if the session has an active spinner.
    return {
        stateChanges: {
            chatSessions: {
                [event.sessionId]: { lastActive: event.ts, ...transcriptPatch, ...(memoryHooks?.patch ?? {}) },
            },
        },
        effects: [
            ...(memoryHooks?.effects ?? []),
            {
                type: "cold_append",
                stream: "hooks",
                entry: {
                    ts: event.ts,
                    sessionId: event.sessionId,
                    claudePid: event.claudePid ?? null,
                    kind: "pre_tool_use",
                    toolName: event.toolName,
                    inputPreview: truncate(event.inputPreview ?? "", 1000),
                },
            },
        ],
    }
}
