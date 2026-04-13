/**
 * lib/effects/session-spinner.js
 *
 * Per-session "spinner" Telegram message. One active spinner per session,
 * tracked on `chatSessions[sessionId].activeSpinner`. Flow:
 *
 *   1. User sends a message that gets routed to a session
 *      → handler emits `start_session_spinner` effect
 *      → tooling sends the "processing..." + tip text, captures
 *        message_id, records it as `kind: "spinner"` in
 *        specialData.telegramMessagesByChatId, and writes the
 *        `activeSpinner` reference onto the session.
 *
 *   2. Pre/PostToolUse hook fires
 *      → handler emits `append_tool_to_spinner` effect with a rendered HTML line
 *      → tooling appends it to the spinner's rolling buffer (cap 10),
 *        re-renders the full message, and calls `editMessageText`.
 *
 *   3. Agent calls `reply`
 *      → handler emits `clear_session_spinner` effect
 *      → tooling nulls out `chatSessions[sid].activeSpinner` so the
 *        next hook will be ignored (there's nothing active to edit).
 *
 * Direct mutation of core state here is a bridging concession — we
 * can't get the Grammy-assigned message_id into a handler's
 * stateChanges because it isn't known until after the send resolves.
 * Same pattern as `recordOutboundMessage`.
 */

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { recordOutboundMessage, applyMessageRecord } = await versionedImport("./telegram-state.js", import.meta)
const { schedulePersist } = await versionedImport("./persistence.js", import.meta)

const ITEMS_CAP = 10
const MAX_MESSAGE_CHARS = 4096

function renderSpinner(headerHtml, items) {
    const body = items.map(i => i.rendered).filter(Boolean).join("\n\n")
    const combined = body ? `${headerHtml}\n\n${body}` : headerHtml
    // Hard-cap at Telegram's max message length. Trim items from the
    // front of the buffer if the combined string is too long.
    if (combined.length <= MAX_MESSAGE_CHARS) {
        return combined
    }
    // Rare case: fall back to trimming the body.
    return combined.slice(0, MAX_MESSAGE_CHARS - 32) + "\n<i>[truncated]</i>"
}

function mutateSession(core, sessionId, patch) {
    const prev = core.chatSessions?.[sessionId]
    if (!prev) {
        return false
    }
    core.chatSessions = {
        ...core.chatSessions,
        [sessionId]: { ...prev, ...patch },
    }
    return true
}

function mutateActiveSpinnerItems(core, sessionId, mutator) {
    const prev = core.chatSessions?.[sessionId]
    const spinner = prev?.activeSpinner
    if (!prev || !spinner) {
        return null
    }
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
    if (!prev) {
        return
    }
    const nextChat = applyMessageRecord(chatMap, { ...prev, ...patch, id: String(messageId) })
    core.specialData = {
        ...(core.specialData ?? {}),
        telegramMessagesByChatId: {
            ...byChat,
            [String(chatId)]: nextChat,
        },
    }
}

/**
 * start_session_spinner effect.
 *
 * Sends the banner message, captures the Grammy-assigned message_id,
 * and writes it to state so subsequent hook effects can edit it.
 */
export async function startSessionSpinner(effect, core) {
    const { chatId, sessionId, headerHtml } = effect
    if (!core.bot) {
        dbg("SPINNER", "no bot")
        return
    }
    if (!sessionId) {
        dbg("SPINNER", "start_session_spinner: missing sessionId")
        return
    }
    let sent
    try {
        sent = await core.bot.api.sendMessage(chatId, headerHtml, { parse_mode: "HTML" })
    } catch (e) {
        dbg("SPINNER", "sendMessage failed:", e)
        return
    }
    if (!sent?.message_id) {
        return
    }
    const messageId = String(sent.message_id)

    // Write the telegramMessagesByChatId entry with kind "spinner" so
    // the reply-to router and any debug dumpers can see the spinner in
    // the per-chat log. items is stored redundantly on the entry for
    // easy introspection.
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

    // Track the spinner reference on the session so hook handlers can
    // find it. If the session already had one, it gets overwritten —
    // the previous spinner is "frozen" in its last-rendered state.
    mutateSession(core, sessionId, {
        activeSpinner: {
            chatId: String(chatId),
            messageId,
            headerHtml,
            items: [],
            createdAt: Date.now(),
        },
    })
    try {
        schedulePersist?.("chatSessions")
    } catch (e) {
        dbg("SPINNER", "schedulePersist chatSessions failed:", e)
    }
}

/**
 * append_tool_to_spinner effect.
 *
 * Appends a rendered tool-status line to the session's active spinner,
 * trims the rolling buffer to ITEMS_CAP, re-renders, and edits the
 * Telegram message in place. No-op if the session has no active
 * spinner — hook events that fire before any user message simply
 * have nowhere to go.
 */
export async function appendToolToSpinner(effect, core) {
    const { sessionId, item } = effect
    if (!core.bot) {
        dbg("SPINNER", "no bot")
        return
    }
    if (!sessionId || !item || typeof item.rendered !== "string") {
        dbg("SPINNER", "append_tool_to_spinner: missing sessionId/item")
        return
    }
    const session = core.chatSessions?.[sessionId]
    const spinner = session?.activeSpinner
    if (!spinner?.messageId) {
        // No spinner to edit — silently skip. This is expected whenever
        // a hook fires before the user's first message or after the
        // spinner was cleared by `reply`.
        return
    }

    const nextSpinner = mutateActiveSpinnerItems(core, sessionId, (items) => {
        items.push({ rendered: item.rendered, ts: item.ts ?? Date.now() })
        while (items.length > ITEMS_CAP) {
            items.shift()
        }
        return items
    })
    if (!nextSpinner) {
        return
    }

    const text = renderSpinner(nextSpinner.headerHtml, nextSpinner.items)
    try {
        await core.bot.api.editMessageText(
            nextSpinner.chatId,
            Number(nextSpinner.messageId),
            text,
            { parse_mode: "HTML" },
        )
    } catch (e) {
        // "message is not modified" is harmless; any other edit failure
        // is worth a log but not a throw. A failed edit doesn't corrupt
        // state — the next append will retry with a newer buffer.
        const msg = String(e?.description ?? e?.message ?? e)
        if (!msg.includes("message is not modified")) {
            dbg("SPINNER", "editMessageText failed:", e)
        }
    }

    // Mirror the items onto the stored message entry so a debug dump
    // sees the current state of the spinner.
    updateStoredSpinnerEntry(core, nextSpinner.chatId, nextSpinner.messageId, {
        items: nextSpinner.items,
        headerHtml: nextSpinner.headerHtml,
    })
    try {
        schedulePersist?.("chatSessions")
        schedulePersist?.("specialData")
    } catch (e) {
        dbg("SPINNER", "schedulePersist failed:", e)
    }
}

/**
 * clear_session_spinner effect.
 *
 * Drops the `activeSpinner` reference on the session so future hooks
 * won't edit the now-frozen spinner. The existing Telegram message is
 * left untouched — it stays in place showing whatever the last edit
 * rendered.
 */
export function clearSessionSpinner(effect, core) {
    const { sessionId } = effect
    if (!sessionId) {
        return
    }
    const prev = core.chatSessions?.[sessionId]
    if (!prev?.activeSpinner) {
        return
    }
    const { activeSpinner: _drop, ...rest } = prev
    core.chatSessions = {
        ...core.chatSessions,
        [sessionId]: rest,
    }
    try {
        schedulePersist?.("chatSessions")
    } catch (e) {
        dbg("SPINNER", "schedulePersist failed:", e)
    }
}
