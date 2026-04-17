// ---------------------------------------------------------------------------
// lib/spinner.js — session spinner policy + IO.
//
// The spinner is the single "processing..." Telegram message a session
// shows between a user's inbound text and the agent's first `reply`.
// Pre/PostToolUse hooks edit the spinner in place (rolling buffer of
// the last N tool-call lines) so we don't pile up a new notification
// per tool call. When the agent finally calls `reply`, the spinner is
// "frozen" — the next user message starts a brand-new one.
//
// ── Why this file exists (vs. a tooling effect module) ────────────────
//
// An earlier iteration had three effect types — start_session_spinner,
// append_tool_to_spinner, clear_session_spinner — dispatched through
// lib/apply-effect.js. Handlers had to know about the spinner and emit the
// right effect at the right time. The policy was therefore scattered:
// chat-user.js knew "user messages start spinners", claude-hook-*.js
// knew "hooks append", claude-channel.js knew "reply clears". That's
// a cross-cutting concern pretending to be three unrelated handler
// decisions.
//
// The current design makes the spinner a BUILT-IN behavior of
// `onEvent`. After the main handler runs and its effects apply, the
// event-loop dispatcher calls `applySpinnerPolicy(event, action,
// core)` in this file; the policy inspects the event type + the
// action's effects and decides what to do. Handlers never touch the
// spinner explicitly. The only place that mutates spinner state is
// inside onEvent's call chain, so the "only onEvent writes state"
// invariant is preserved.
//
// ── Why direct mutation (bridging concession) ─────────────────────────
//
// Grammy's `sendMessage` returns the newly-assigned `message_id` as a
// Promise. The spinner needs that id recorded in state BEFORE the
// next event is dispatched (otherwise the next Pre/PostToolUse hook
// won't find a spinner to edit — there's a race window). Returning a
// stateChanges patch from a handler wouldn't work because the handler
// can't know the id yet. So the policy mutates `core.chatSessions`
// and `core.specialData` directly, through the core setters, after
// awaiting each Grammy call.
//
// The mutation is documented in main-event-processor.js and CLAUDE.md
// as the ONE approved direct-write site post-Phase-B.
// ---------------------------------------------------------------------------

import { versionedImport } from "./version.js"

const { dbg } = await versionedImport("./logging.js", import.meta)
const { formatPreToolUse, formatPostToolUse } = await versionedImport("./pure/hook-format.js", import.meta)
const { getRandomTip } = await versionedImport("./hot-commands.js", import.meta)
const { recordOutboundMessage, applyMessageRecord } = await versionedImport("./effects/telegram-state.js", import.meta)
const { schedulePersist } = await versionedImport("./effects/persistence.js", import.meta)

const ITEMS_CAP = 10
const MAX_MESSAGE_CHARS = 4096

// ── Rendering ────────────────────────────────────────────────────────

function renderHeader() {
    const tip = getRandomTip()
    const tipLine = tip ? `\n\n<i>did you know:</i> ${tip}` : ""
    return `<i>processing...</i>${tipLine}`
}

function renderSpinner(headerHtml, items) {
    // Items are joined with a single newline — no blank-line padding
    // between tool-call lines so the spinner stays compact.
    const body = items.map(i => i.rendered).filter(Boolean).join("\n")
    const combined = body ? `${headerHtml}\n\n${body}` : headerHtml
    if (combined.length <= MAX_MESSAGE_CHARS) {
        return combined
    }
    return combined.slice(0, MAX_MESSAGE_CHARS - 32) + "\n<i>[truncated]</i>"
}

// ── State helpers (direct mutation — see file header) ───────────────

function setSessionSpinner(core, sessionId, spinner) {
    const prev = core.chatSessions?.[sessionId]
    if (!prev) { return }
    core.chatSessions = {
        ...core.chatSessions,
        [sessionId]: { ...prev, activeSpinner: spinner },
    }
}

function mutateSpinnerItems(core, sessionId, mutator) {
    const prev = core.chatSessions?.[sessionId]
    const spinner = prev?.activeSpinner
    if (!prev || !spinner) { return null }
    const nextItems = mutator([...(spinner.items ?? [])])
    const nextSpinner = { ...spinner, items: nextItems }
    core.chatSessions = {
        ...core.chatSessions,
        [sessionId]: { ...prev, activeSpinner: nextSpinner },
    }
    return nextSpinner
}

function updateStoredSpinnerEntry(core, chatId, messageId, patch) {
    const byChat = core.specialData?.telegramMessagesByChatId ?? {}
    const chatMap = byChat[String(chatId)] ?? {}
    const prev = chatMap[String(messageId)]
    if (!prev) { return }
    const nextChat = applyMessageRecord(chatMap, { ...prev, ...patch, id: String(messageId) })
    core.specialData = {
        ...(core.specialData ?? {}),
        telegramMessagesByChatId: {
            ...byChat,
            [String(chatId)]: nextChat,
        },
    }
}

function clearSessionSpinner(core, sessionId) {
    const prev = core.chatSessions?.[sessionId]
    if (!prev?.activeSpinner) { return }
    const { activeSpinner: _drop, ...rest } = prev
    core.chatSessions = {
        ...core.chatSessions,
        [sessionId]: rest,
    }
    try { schedulePersist?.("chatSessions") } catch (e) { dbg("SPINNER", "schedulePersist:", e) }
}

// ── IO: send + edit ──────────────────────────────────────────────────

async function sendSpinnerMessage(core, chatId, sessionId, threadId) {
    if (!core.bot) {
        dbg("SPINNER", "no bot — skipping spinner start")
        return
    }
    const headerHtml = renderHeader()
    const opts = { format: "html", silent: true }
    if (threadId != null) { opts.threadId = threadId }
    let sent
    try {
        sent = await core.bot.sendText(chatId, headerHtml, opts)
    } catch (e) {
        dbg("SPINNER", "sendText failed:", e)
        return
    }
    if (!sent?.messageId) { return }
    const messageId = sent.messageId

    recordOutboundMessage(core, {
        id: messageId,
        chatId: String(chatId),
        from: "agent",
        kind: "spinner",
        sessionId,
        text: headerHtml.slice(0, 500),
        items: [],
        headerHtml,
    })

    setSessionSpinner(core, sessionId, {
        chatId: String(chatId),
        messageId,
        headerHtml,
        items: [],
        createdAt: Date.now(),
    })
    try { schedulePersist?.("chatSessions") } catch (e) { dbg("SPINNER", "schedulePersist:", e) }
}

/**
 * Push a new tool-call line onto the spinner (or replace an existing
 * one in place when `toolUseId` matches). Pre/PostToolUse hooks share
 * a `toolUseId`, so the PostTool event finds its own PreTool item and
 * overwrites it — the reader sees the tool transition from
 * "Reading foo.js" → "☑️ Read foo.js" in the same slot instead of
 * both lines stacking.
 */
async function appendSpinnerItem(core, sessionId, rendered, ts, toolUseId) {
    if (!core.bot) { return }
    const nextSpinner = mutateSpinnerItems(core, sessionId, (items) => {
        if (toolUseId) {
            const idx = items.findIndex((it) => it.toolUseId === toolUseId)
            if (idx >= 0) {
                items[idx] = { ...items[idx], rendered, ts: ts ?? Date.now() }
                return items
            }
        }
        items.push({ rendered, ts: ts ?? Date.now(), toolUseId: toolUseId ?? null })
        while (items.length > ITEMS_CAP) {
            items.shift()
        }
        return items
    })
    if (!nextSpinner) { return }

    const text = renderSpinner(nextSpinner.headerHtml, nextSpinner.items)
    try {
        await core.bot.editText(
            nextSpinner.chatId,
            nextSpinner.messageId,
            text,
            { format: "html" },
        )
    } catch (e) {
        const msg = String(e?.description ?? e?.message ?? e)
        if (!msg.includes("message is not modified")) {
            dbg("SPINNER", "editText failed:", e)
        }
    }

    updateStoredSpinnerEntry(core, nextSpinner.chatId, nextSpinner.messageId, {
        items: nextSpinner.items,
        headerHtml: nextSpinner.headerHtml,
    })
    try {
        schedulePersist?.("chatSessions")
        schedulePersist?.("specialData")
    } catch (e) { dbg("SPINNER", "schedulePersist:", e) }
}

// ── Policy ───────────────────────────────────────────────────────────

/**
 * Called by `onEvent` in lib/main-event-processor.js after the main
 * handler's stateChanges + effects have been applied. The policy
 * decides what (if anything) to do with the spinner based on the
 * event type and the handler's returned action.
 *
 * @param {object} event — the dequeued event
 * @param {object|null} action — the handler's returned Action
 * @param {object} core — the shell kernel
 */
export async function applySpinnerPolicy(event, action, core) {
    if (!event || !event.type) { return }

    // ── Start: a chat user message routed to a live session ────────
    if (event.type === "chat_user_message" && action?.effects) {
        // Actions can opt out of the spinner via `noSpinner: true`.
        // This is what /task_cancel_<id> and similar "system control"
        // commands use — they emit a deliver_channel_event to tell the
        // worker what happened, but they're NOT waiting for a reply so
        // a "processing..." spinner would be misleading (and never
        // clear, because the worker doesn't call `reply` to ACK).
        if (action.noSpinner) {
            // Also drop any existing spinner on the target session so
            // a stale one from before the cancel doesn't linger.
            const deliver = action.effects.find(e => e?.type === "deliver_channel_event")
            if (deliver?.sessionId) {
                clearSessionSpinner(core, deliver.sessionId)
            }
            return
        }
        // The handler signals "this event reached a session" by
        // emitting a `deliver_channel_event` effect. That's the
        // cleanest cross-check: we don't need to re-run the routing
        // logic here; the action tells us which sessionId won.
        const deliver = action.effects.find(e => e?.type === "deliver_channel_event")
        if (deliver?.sessionId) {
            // If the message came from a command center topic, send the
            // spinner into that topic (not the General topic).
            const threadId = event.threadId ?? null
            await sendSpinnerMessage(core, event.chatId, deliver.sessionId, threadId)
        }
        return
    }

    // ── Append: Pre/PostToolUse hook on sessions with active spinners ─
    // In command center mode multiple sessions run concurrently in
    // different topics, so we update any session that has an active
    // spinner — not just the focused one.
    if (event.type === "claude_hook_pre_tool_use" || event.type === "claude_hook_post_tool_use") {
        if (!event.sessionId) { return }
        const isCommandCenter = !!core.chatState?.commandCenter?.chatId
        if (!isCommandCenter && core.chatState?.focusedSessionId !== event.sessionId) { return }
        const session = core.chatSessions?.[event.sessionId]
        if (!session?.activeSpinner) { return }

        const format = event.type === "claude_hook_pre_tool_use"
            ? formatPreToolUse
            : formatPostToolUse
        const rendered = format({
            tool_name: event.toolName,
            input_preview: event.inputPreview,
            output_preview: event.outputPreview,
            is_error: event.isError,
        })
        if (rendered === null) { return }

        await appendSpinnerItem(core, event.sessionId, rendered, event.ts, event.toolUseId ?? null)
        return
    }

    // ── Clear: agent called `reply`, freeze the current spinner ────
    if (event.type === "claude_channel_tool_request"
        && event.toolName === "reply"
        && event.sessionId) {
        clearSessionSpinner(core, event.sessionId)
        return
    }
}
