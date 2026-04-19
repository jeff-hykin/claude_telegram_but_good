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

const { dbg } = await versionedImport("./logging.js", import.meta)
const { mergeSessionData } = await versionedImport("./pure/state-merge.js", import.meta)
const { applySpinnerPolicy } = await versionedImport("./spinner.js", import.meta)
const { maybeHealShim } = await versionedImport("./shim-health.js", import.meta)
const persistenceMod = await versionedImport("./effects/persistence.js", import.meta)
const schedulePersist = persistenceMod.schedulePersist

// ── Effect implementations ────────────────────────────────────────────
//
// Every module under lib/effects/ gets loaded ONCE here (per cbgVersion,
// via versionedImport). The flat `effectDispatch` table below maps each
// effect.type string to the implementation function. The effect loop in
// onEvent() does a single table lookup per effect — no switch, no
// dynamic dispatch per call, and the list of known effect types is
// visible at a glance.
//
// This used to live in a separate lib/apply-effect.js module with a
// 70-line switch statement. Inlining keeps the event-loop's two
// dispatch tables (handlers + effectDispatch) side by side so anyone
// adding a new handler + effect pair edits one file.

const [
    telegramOutbound,
    dtachOutbound,
    ipcOutbound,
    timersEffect,
    criticSubprocess,
    coldStorageEffect,
    channelEvent,
    filesystemEffect,
    hotCommandRunner,
    telegramDownload,
    processEffect,
    scheduleTimer,
    scheduledTaskWorker,
] = await Promise.all([
    versionedImport("./effects/telegram-outbound.js", import.meta),
    versionedImport("./effects/dtach-outbound.js", import.meta),
    versionedImport("./effects/ipc-outbound.js", import.meta),
    versionedImport("./effects/timers.js", import.meta),
    versionedImport("./effects/critic-subprocess.js", import.meta),
    versionedImport("./effects/cold-storage-effect.js", import.meta),
    versionedImport("./effects/channel-event.js", import.meta),
    versionedImport("./effects/filesystem.js", import.meta),
    versionedImport("./effects/hot-command-runner.js", import.meta),
    versionedImport("./effects/telegram-download.js", import.meta),
    versionedImport("./effects/process.js", import.meta),
    versionedImport("./effects/schedule-timer.js", import.meta),
    versionedImport("./effects/scheduled-task-worker.js", import.meta),
])

/**
 * Merge a `{ chatState?, chatSessions?, specialData? }` patch into core.
 * Used in two places: the handler-returned Action's top-level
 * `stateChanges`, and the per-effect return patches (e.g. when
 * telegram-outbound captures a Grammy message_id and needs to record
 * it in specialData AFTER the async send resolves). Having ONE helper
 * means the two call sites can't drift on which slices get persisted
 * or how — the alternative (inlining) bit us recently when a dangling
 * `applyStateChanges(...)` call was left uninitialized by a previous
 * refactor and silently swallowed every outbound-record patch via the
 * try/catch in the effect loop.
 *
 * File-local (not exported) to keep this coupled to onEvent's own
 * merge semantics + schedulePersist wiring.
 */
function applyStateChanges(patch, core) {
    if (!patch) { return }
    if (patch.chatState !== undefined) {
        core.chatState = mergeSessionData(core.chatState, patch.chatState)
        try { schedulePersist?.("chatState") } catch (e) { dbg("EVENT", "schedulePersist chatState:", e) }
    }
    if (patch.chatSessions !== undefined) {
        core.chatSessions = mergeSessionData(core.chatSessions, patch.chatSessions)
        try { schedulePersist?.("chatSessions") } catch (e) { dbg("EVENT", "schedulePersist chatSessions:", e) }
    }
    if (patch.specialData !== undefined) {
        core.specialData = mergeSessionData(core.specialData, patch.specialData)
        try { schedulePersist?.("specialData") } catch (e) { dbg("EVENT", "schedulePersist specialData:", e) }
    }
}

const effectDispatch = {
    // Telegram outbound
    "send_text_to_user":      telegramOutbound.sendTextMessageToUser,
    "send_file_to_user":      telegramOutbound.sendFileToUser,
    "send_reaction":          telegramOutbound.sendReaction,
    "edit_telegram_message":  telegramOutbound.editTelegramMessage,
    "answer_callback_query":  telegramOutbound.answerCallbackQuery,
    // Thread / Forum Topic
    "create_thread":          telegramOutbound.createThread,
    "delete_thread":          telegramOutbound.deleteThread,
    "rename_thread":          telegramOutbound.renameThread,
    // Claude-session (dtach)
    "send_text_to_claude":    dtachOutbound.sendTextToClaude,
    "send_files_to_claude":   dtachOutbound.sendFilesToClaude,
    // Shim / CLI IPC
    "ipc_respond":            ipcOutbound.ipcRespond,
    // Event loop primitives
    "set_timer":              timersEffect.setTimer,
    // Long-task critic subprocess
    "spawn_critic":           criticSubprocess.spawnCriticSubprocess,
    // Cold storage (append-only JSONL)
    "cold_append":            coldStorageEffect.coldAppend,
    // Deliver a Telegram message (via IPC) to a specific shim
    "deliver_channel_event":  channelEvent.deliverChannelEvent,
    // Filesystem + version-bump
    "write_file":             filesystemEffect.writeFile,
    "delete_file":            filesystemEffect.deleteFile,
    "move_file":              filesystemEffect.moveFile,
    "mkdir":                  filesystemEffect.mkdir,
    "bump_cbg_version":       filesystemEffect.bumpCbgVersion,
    // Hot-reloadable command registry
    "reload_hot_commands":    hotCommandRunner.reloadHotCommands,
    // Download a Telegram file to INBOX_DIR (for photo attachments)
    "download_telegram_file": telegramDownload.downloadTelegramFile,
    // Process signal (used by graceful-close fallback)
    "signal_process":         processEffect.signalProcess,
    // Scheduled tasks
    "schedule_timer_set":             scheduleTimer.scheduleTimerSet,
    "schedule_timer_clear":           scheduleTimer.scheduleTimerClear,
    "scheduled_task_worker_spawn":    scheduledTaskWorker.spawnScheduledTaskWorker,
    "scheduled_task_worker_inject":   scheduledTaskWorker.injectScheduledTaskText,
    "scheduled_task_worker_kill":     scheduledTaskWorker.killScheduledTaskWorker,
}

const handlers = {
    "cli_command": (await versionedImport("./event-handlers/cli-command.js", import.meta)).default,
    "server_dump": (await versionedImport("./event-handlers/server-dump.js", import.meta)).default,
    "long_task_definition_submitted": (await versionedImport("./event-handlers/long-task-definition-submitted.js", import.meta)).default,
    "scheduled_task_definition_submitted": (await versionedImport("./event-handlers/scheduled-task-definition-submitted.js", import.meta)).default,
    "create_scheduled_task": (await versionedImport("./event-handlers/create-scheduled-task.js", import.meta)).default,
    "scheduled_task_fire": (await versionedImport("./event-handlers/scheduled-task-fire.js", import.meta)).default,
    "scheduled_task_worker_report_ready": (await versionedImport("./event-handlers/scheduled-task-report-ready.js", import.meta)).default,
    "scheduled_task_run_complete": (await versionedImport("./event-handlers/scheduled-task-run-complete.js", import.meta)).default,
    "scheduled_task_rehydrate": (await versionedImport("./event-handlers/scheduled-task-rehydrate.js", import.meta)).default,
    "session_register": (await versionedImport("./event-handlers/session-register.js", import.meta)).default,
    "session_register_no_dtach": (await versionedImport("./event-handlers/session-register-no-dtach.js", import.meta)).default,
    "session_unregister": (await versionedImport("./event-handlers/session-unregister.js", import.meta)).default,
    "session_force_close": (await versionedImport("./event-handlers/session-force-close.js", import.meta)).default,
    "ipc_connection_closed": (await versionedImport("./event-handlers/ipc-connection-closed.js", import.meta)).default,
    "claude_hook_stop": (await versionedImport("./event-handlers/claude-hook-stop.js", import.meta)).default,
    "claude_hook_pre_tool_use": (await versionedImport("./event-handlers/claude-hook-pre-tool-use.js", import.meta)).default,
    "claude_hook_post_tool_use": (await versionedImport("./event-handlers/claude-hook-post-tool-use.js", import.meta)).default,
    "claude_channel_tool_request": (await versionedImport("./event-handlers/claude-channel.js", import.meta)).default,
    "download_complete_for_tool": (await versionedImport("./event-handlers/download-complete-for-tool.js", import.meta)).default,
    "critic_verdict": (await versionedImport("./event-handlers/critic-verdict.js", import.meta)).default,
    "chat_user_message": (await versionedImport("./event-handlers/chat-user.js", import.meta)).default,
    "telegram_callback_query": (await versionedImport("./event-handlers/telegram-callback-query.js", import.meta)).default,
    "forum_topic_created": (await versionedImport("./event-handlers/forum-topic-created.js", import.meta)).default,
    "forum_topic_edited": (await versionedImport("./event-handlers/forum-topic-edited.js", import.meta)).default,
    "permission_request": (await versionedImport("./event-handlers/permission-request.js", import.meta)).default,
    // Stall-detector periodics. screen_snapshot_tick runs every
    // `screen_snapshot_interval_ms` for the lifetime of the daemon;
    // stall_check runs on-demand per session whenever we enter a
    // "waiting on agent" state.
    "screen_snapshot_tick": (await versionedImport("./event-handlers/tui-snapshot.js", import.meta)).default,
    "stall_check": (await versionedImport("./event-handlers/stall-check.js", import.meta)).default,
    "tui_prompt_detected": (await versionedImport("./event-handlers/tui-prompt-detected.js", import.meta)).default,
    "task_checkin": (await versionedImport("./event-handlers/task-checkin.js", import.meta)).default,
    "stop_nudge_fire": (await versionedImport("./event-handlers/stop-nudge-fire.js", import.meta)).default,
    "agent_timer_fire": (await versionedImport("./event-handlers/agent-timer-fire.js", import.meta)).default,
    "agent_file_watch_tick": (await versionedImport("./event-handlers/agent-file-watch-tick.js", import.meta)).default,
    // Note: there is NO `session_timer` event type. The set_timer tooling
    // fires arbitrary events (whatever the handler put in the effect's
    // `event` field), which get dispatched to their normal handlers.
}


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

    // Self-heal the claude CLI shim if it has been clobbered (e.g. by
    // `npm i -g @anthropic-ai/claude-code` or Claude Code auto-update).
    // Throttled to at most one filesystem check per 20 s across all
    // events — see lib/shim-health.js. Wrapped in try so a healer
    // exception cannot stall the dispatcher.
    try { maybeHealShim() } catch (e) { dbg("EVENT", "shim heal threw:", e) }

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

    // Apply the handler's stateChanges (if any) before running effects.
    // See applyStateChanges (file-local) — same helper used for the
    // effect-return patches below.
    applyStateChanges(action.stateChanges, core)

    // Apply effects in order. Effects MAY return `{ stateChanges }`
    // to describe state patches based on information only available
    // after an async side effect resolves — the canonical case is
    // `telegram-outbound.js` capturing the Grammy `message_id`
    // returned by `bot.sendText` and using it to record the outbound
    // in `specialData.telegramMessagesByChatId`. We apply each
    // returned patch IMMEDIATELY (via applyStateChanges, the same
    // helper the handler-patch block above uses) so subsequent
    // effects in the same Action observe the update.
    //
    // Dispatch uses the `effectDispatch` table built at module top —
    // one table lookup per effect, no switch and no per-call import.
    if (Array.isArray(action.effects)) {
        for (const effect of action.effects) {
            if (!effect || typeof effect.type !== "string") {
                dbg("EVENT", "skipping invalid effect:", effect)
                continue
            }
            const fn = effectDispatch[effect.type]
            if (typeof fn !== "function") {
                dbg("EVENT", `unknown effect type: ${effect.type}`)
                continue
            }
            try {
                const result = await fn(effect, core)
                if (result && typeof result === "object" && result.stateChanges) {
                    applyStateChanges(result.stateChanges, core)
                }
            } catch (e) {
                dbg("EVENT", `effect ${effect.type} failed:`, e)
            }
        }
    }

    // Built-in spinner policy. Runs after the handler's effects have
    // been applied so the policy can key off Grammy message IDs that
    // may have just been assigned + written into state. Errors here
    // are logged but never re-thrown — a failing spinner must not
    // stall the event loop.
    try {
        await applySpinnerPolicy(event, action, core)
    } catch (e) {
        dbg("SPINNER_EVENT", `spinner policy failed for ${event.type}:`, e)
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
