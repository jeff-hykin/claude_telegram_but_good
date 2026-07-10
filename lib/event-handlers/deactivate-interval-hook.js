// lib/event-handlers/deactivate-interval-hook.js
//
// Handler for the deactivate_interval_hook MCP tool (and the
// /interval_hook_off_<id> command via cli path). Hot-deactivates an
// interval hook: flips active=false and clears its in-process timer so
// it stops firing immediately. Idempotent.

import { versionedImport } from "../version.js"
const { dbg } = await versionedImport("../logging.js", import.meta)
const { findIntervalHook } = await versionedImport("../interval-hook-actions.js", import.meta)

function reply(event, text, isError = false) {
    if (!event._conn || !event.requestId) { return { effects: [] } }
    return {
        effects: [{
            type: "ipc_respond",
            conn: event._conn,
            message: {
                type: "tool_response",
                requestId: event.requestId,
                result: { content: [{ type: "text", text }], isError },
            },
        }],
    }
}

export default function handle(event, core) {
    const { hookId } = event
    if (!hookId) {
        return reply(event, "hookId is required", true)
    }
    const found = findIntervalHook(core.specialData, hookId)
    if (!found) {
        return reply(event, `Unknown interval hook: ${hookId}`, true)
    }
    if (!found.hook.active) {
        return {
            ...reply(event, `Interval hook ${hookId} is already deactivated.`),
        }
    }

    dbg("IHOOK-OFF", `deactivating ${hookId}`)
    const base = reply(event, `Interval hook ${hookId} deactivated. It will not fire again until reactivated.`)
    return {
        stateChanges: {
            specialData: {
                intervalHookByChatId: {
                    [found.chatId]: { [hookId]: { active: false } },
                },
            },
        },
        effects: [
            { type: "interval_hook_timer_clear", hookId },
            {
                type: "cold_append",
                stream: "interval-hooks",
                entry: { hookId, chatId: found.chatId, event: "deactivated" },
            },
            ...(base.effects ?? []),
        ],
    }
}
