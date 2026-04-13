// ---------------------------------------------------------------------------
// lib/main-event-processor.js — the core `onEvent` dispatcher.
//
// The main-server shell is just an event queue + a loop; this file is the
// body of that loop. For every event pulled off the queue, main-server.js
// re-imports this module via versionedImport and calls the exported
// `onEvent(event, core)`. When globalThis.cbgVersion changes, the next
// event gets a fresh copy of this module — and because the handler
// dispatch table below is built at the top level using versionedImport,
// every handler module is re-imported in lockstep. The whole graph
// refreshes cascadingly.
//
// Handlers never touch `core` directly. They return an Action describing
// state patches, side effects, and follow-up events; this dispatcher is
// the single funnel that applies them.
// ---------------------------------------------------------------------------

import { versionedImport } from "./version.js"

// Top-level versioned imports — these run once per module instantiation
// (i.e. once per hot-reload version). Each new version reloads the whole
// dependency subgraph in lockstep.
const { dbg } = await versionedImport("./logging.js", import.meta)
const { mergeSessionData } = await versionedImport("./pure/state-merge.js", import.meta)

// Handler dispatch table — built at module load time so we don't pay an
// import cost per event. Adding a new handler means adding it here.
// Missing handlers are tolerated at dispatch time (we log and bail), so a
// skeleton-phase file that doesn't exist yet won't crash the loop — but
// it WILL crash this top-level load if you list it here without creating
// the file. Only register handlers whose files actually exist.
const handlers = {
    "cli_command": (await versionedImport("./event-handlers/cli-command.js", import.meta)).default,
    "server_dump": (await versionedImport("./event-handlers/server-dump.js", import.meta)).default,
    "long_task_definition_submitted": (await versionedImport("./event-handlers/long-task-definition-submitted.js", import.meta)).default,
    "session_register": (await versionedImport("./event-handlers/session-register.js", import.meta)).default,
    "session_unregister": (await versionedImport("./event-handlers/session-unregister.js", import.meta)).default,
    "ipc_connection_closed": (await versionedImport("./event-handlers/ipc-connection-closed.js", import.meta)).default,
    "claude_hook_stop": (await versionedImport("./event-handlers/claude-hook-stop.js", import.meta)).default,
    "claude_hook_pre_tool_use": (await versionedImport("./event-handlers/claude-hook-pre-tool-use.js", import.meta)).default,
    "claude_hook_post_tool_use": (await versionedImport("./event-handlers/claude-hook-post-tool-use.js", import.meta)).default,
    "claude_channel_tool_request": (await versionedImport("./event-handlers/claude-channel.js", import.meta)).default,
    "download_complete_for_tool": (await versionedImport("./event-handlers/download-complete-for-tool.js", import.meta)).default,
    "critic_verdict": (await versionedImport("./event-handlers/critic-verdict.js", import.meta)).default,
    "telegram_user_message": (await versionedImport("./event-handlers/telegram-user.js", import.meta)).default,
    "telegram_callback_query": (await versionedImport("./event-handlers/telegram-callback-query.js", import.meta)).default,
    "permission_request": (await versionedImport("./event-handlers/permission-request.js", import.meta)).default,
    // Note: there is NO `session_timer` event type. The set_timer tooling
    // fires arbitrary events (whatever the handler put in the effect's
    // `event` field), which get dispatched to their normal handlers.
}

// Effect runner — also loaded once per module version.
const { applyEffect } = await versionedImport("./effects/apply-effect.js", import.meta)

// Persistence helper for scheduling debounced specialData writes.
const persistenceMod = await versionedImport("./effects/persistence.js", import.meta)
const schedulePersist = persistenceMod.schedulePersist

/**
 * Dispatch a single event through its handler and apply the resulting Action.
 *
 * Never throws. Any failure — unknown type, handler exception, effect
 * exception — is logged via `dbg("EVENT", ...)` so the loop keeps draining
 * the queue.
 *
 * @param {object} event  dequeued event, must have `type`
 * @param {object} core   shell-owned mutable container (see main-server.js)
 * @returns {Promise<void>}
 */
export async function onEvent(event, core) {
    if (!event || typeof event.type !== "string") {
        dbg("EVENT", "invalid event (no type)")
        return
    }

    // Bump eventsProcessed stat. Stats live on chatState so they persist
    // the same way the rest of the chat state does.
    const prevStats = core.chatState?.stats ?? {}
    core.chatState = mergeSessionData(core.chatState, {
        stats: { eventsProcessed: (prevStats.eventsProcessed ?? 0) + 1 },
    })

    // Dispatch.
    const handle = handlers[event.type]
    if (typeof handle !== "function") {
        dbg("EVENT", `no handler for event type: ${event.type}`)
        return
    }

    let action
    try {
        action = await handle(event, core)
    } catch (e) {
        dbg("EVENT", `handler ${event.type} threw:`, e)
        return
    }

    if (!action) { return }

    // Apply state changes. Every slice is replaced wholesale via
    // mergeSessionData(current, patch) — never mutated in place.
    // Every changed slice schedules a debounced persistence write so a
    // daemon restart can restore state. flushPersistenceNow() on shutdown
    // unconditionally flushes all three, so even unchanged slices land.
    if (action.stateChanges) {
        if (action.stateChanges.chatState !== undefined) {
            core.chatState = mergeSessionData(core.chatState, action.stateChanges.chatState)
            try { schedulePersist?.("chatState") } catch (e) { dbg("EVENT", "schedulePersist chatState:", e) }
        }
        if (action.stateChanges.chatSessions !== undefined) {
            core.chatSessions = mergeSessionData(core.chatSessions, action.stateChanges.chatSessions)
            try { schedulePersist?.("chatSessions") } catch (e) { dbg("EVENT", "schedulePersist chatSessions:", e) }
        }
        if (action.stateChanges.specialData !== undefined) {
            core.specialData = mergeSessionData(core.specialData, action.stateChanges.specialData)
            try { schedulePersist?.("specialData") } catch (e) { dbg("EVENT", "schedulePersist specialData:", e) }
        }
    }

    // Apply effects in order.
    if (Array.isArray(action.effects)) {
        for (const effect of action.effects) {
            if (!effect || typeof effect.type !== "string") {
                dbg("EVENT", "skipping invalid effect:", effect)
                continue
            }
            try {
                await applyEffect(effect, core)
            } catch (e) {
                dbg("EVENT", `effect ${effect.type} failed:`, e)
            }
        }
    }

    // Enqueue follow-up events. They go back through the same queue the
    // shell is draining, so they'll be processed on subsequent iterations.
    if (Array.isArray(action.followUpEvents)) {
        for (const ev of action.followUpEvents) {
            if (!ev || typeof ev.type !== "string") {
                dbg("EVENT", "skipping invalid follow-up:", ev)
                continue
            }
            try {
                core.enqueueEvent({ ...ev, ts: ev.ts ?? Date.now() })
            } catch (e) {
                dbg("EVENT", "enqueue follow-up failed:", e)
            }
        }
    }
}
