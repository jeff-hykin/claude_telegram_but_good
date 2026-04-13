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

function truncate(s, max) {
    if (typeof s !== "string") { return s }
    if (s.length <= max) { return s }
    return s.slice(0, max - 3) + "..."
}

export default function handle(event, core) {
    if (!event.sessionId) {
        dbg("HOOK-PRE", "no sessionId (claudePid unresolved) — skipping")
        return { stateChanges: {}, effects: [] }
    }

    const session = core.chatSessions?.[event.sessionId]
    if (!session) {
        dbg("HOOK-PRE", `no session found for ${event.sessionId} — skipping`)
        return { stateChanges: {}, effects: [] }
    }

    const focusedId = core.chatState?.focusedSessionId
    if (event.sessionId !== focusedId) {
        dbg(
            "HOOK-PRE",
            `ignoring non-focused session ${event.sessionId} (focused=${focusedId})`,
        )
        return { stateChanges: {}, effects: [] }
    }

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
                    [event.sessionId]: { lastActive: event.ts },
                },
            },
            effects: [],
        }
    }

    dbg("HOOK-PRE", `${event.sessionId} ${event.toolName}`)

    return {
        stateChanges: {
            chatSessions: {
                [event.sessionId]: { lastActive: event.ts },
            },
        },
        effects: [
            {
                type: "append_tool_to_spinner",
                sessionId: event.sessionId,
                item: { rendered, ts: event.ts },
            },
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
