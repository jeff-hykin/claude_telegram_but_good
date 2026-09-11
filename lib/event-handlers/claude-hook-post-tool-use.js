// ---------------------------------------------------------------------------
// claude_hook_post_tool_use handler.
//
// Fired after Claude has finished a tool call. Mirrors the pre-tool-use
// handler: same bail conditions, same "update lastActive + cold-append"
// shape, using the post formatter. No Telegram effects in v1 (see the
// comment in claude-hook-pre-tool-use.js for why).
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { formatPostToolUse } = await versionedImport("../pure/hook-format.js", import.meta)
const { toolHookAction } = await versionedImport("../memory-hooks.js", import.meta)

function formatDuration(ms) {
    if (ms < 1000) { return `${ms}ms` }
    const totalSeconds = Math.round(ms / 1000)
    if (totalSeconds < 60) { return `${totalSeconds}s` }
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return `${minutes}m${String(seconds).padStart(2, "0")}s`
}

function truncate(s, max) {
    if (typeof s !== "string") { return s }
    if (s.length <= max) { return s }
    return s.slice(0, max - 3) + "..."
}

export default function handle(event, core) {
    if (!event.sessionId) {
        dbg("HOOK-POST", "no sessionId (claudePid unresolved) — skipping")
        return { stateChanges: {}, effects: [] }
    }

    const session = core.chatSessions?.[event.sessionId]
    if (!session) {
        dbg("HOOK-POST", `no session found for ${event.sessionId} — skipping`)
        return { stateChanges: {}, effects: [] }
    }

    // The matching PreToolUse recorded this call in session.activeTools;
    // drop it and report how long the call took. A `backgroundedAt` stamp
    // means the slow-tool watchdog moved it to the background — the
    // duration is then time-to-background, not the command's run time.
    const toolUseId = typeof event.toolUseId === "string" && event.toolUseId ? event.toolUseId : null
    const active = toolUseId ? session.activeTools?.[toolUseId] : null
    const durationMs = active?.startedAt != null ? Math.max(0, event.ts - active.startedAt) : null
    const activeToolsPatch = active ? { activeTools: { [toolUseId]: undefined } } : {}
    const timing = durationMs == null
        ? ""
        : ` (${formatDuration(durationMs)}${active.backgroundedAt ? ", backgrounded" : ""})`

    const rendered = formatPostToolUse({
        tool_name: event.toolName,
        input_preview: event.inputPreview,
        output_preview: event.outputPreview,
        is_error: event.isError,
    })
    if (rendered === null) {
        dbg("HOOK-POST", `formatter hid tool ${event.toolName} — skipping`)
        return {
            stateChanges: {
                chatSessions: {
                    [event.sessionId]: { lastActive: event.ts, ...activeToolsPatch },
                },
            },
            effects: [],
        }
    }

    dbg(
        "HOOK-POST",
        `${event.sessionId} ${event.toolName} ${event.isError ? "error" : "ok"}${timing}`,
    )

    // Memory hooks — see the note in claude-hook-pre-tool-use.js. Post also
    // matches the tool's OUTPUT, which is where a result contradicts a
    // standing note (a calendar listing an event Jeff never attends).
    const memoryHooks = toolHookAction(session, event.sessionId, [event.toolName, event.inputPreview, event.outputPreview])

    // No spinner append effect emitted — the built-in spinner policy
    // in main-event-processor.js handles the append.
    return {
        stateChanges: {
            chatSessions: {
                [event.sessionId]: { lastActive: event.ts, ...activeToolsPatch, ...(memoryHooks?.patch ?? {}) },
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
                    kind: "post_tool_use",
                    toolName: event.toolName,
                    durationMs,
                    backgrounded: !!active?.backgroundedAt,
                    inputPreview: truncate(event.inputPreview ?? "", 1000),
                    outputPreview: truncate(event.outputPreview ?? "", 1000),
                    isError: event.isError === true,
                },
            },
        ],
    }
}
