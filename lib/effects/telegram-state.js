/**
 * lib/effects/telegram-state.js
 *
 * Helpers for maintaining `specialData.telegramMessagesByChatId` —
 * the per-chat message log used for reply-to routing, spinner
 * rolling buffers, and activity display.
 *
 * The log is a plain object keyed by chat_id, whose value is an object
 * keyed by message_id. Each entry has:
 *   { id, chatId, from: "user"|"agent"|"system", kind, ts, text,
 *     sessionId?, userId?, replyToMessageId?, items? }
 *
 * Capacity: each chat holds up to MAX_MESSAGES_PER_CHAT entries. When
 * the cap is exceeded on insertion, the oldest entries (by ts) are
 * dropped to stay at the cap.
 *
 * Two call sites:
 *   - Handlers (inbound user messages): use `buildRecordPatch` to
 *     produce a state patch they return from their Action.
 *   - Tooling (outbound bot messages): use `recordOutboundMessage` to
 *     mutate `core.specialData` directly after a successful send.
 *     This is a bridging concession — Grammy's message_id isn't
 *     available until the send resolves, and we need it reflected in
 *     state so the very next hook event can find the spinner.
 */

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
// Resolved once per module version at load time — every outbound
// message records through `recordOutboundMessage`, so paying the
// versionedImport cost per call was a real hot-path tax.
const { schedulePersist } = await versionedImport("./persistence.js", import.meta)

export const MAX_MESSAGES_PER_CHAT = 100

/**
 * Merge `entry` into `chatMap` (a {messageId -> entry} map), evicting
 * oldest entries by ts if the result would exceed the cap. Pure.
 */
export function applyMessageRecord(chatMap, entry) {
    const id = String(entry.id)
    const next = { ...(chatMap ?? {}) }
    next[id] = entry
    const ids = Object.keys(next)
    if (ids.length > MAX_MESSAGES_PER_CHAT) {
        const sorted = ids
            .map(k => ({ k, ts: Number(next[k]?.ts) || 0 }))
            .sort((a, b) => a.ts - b.ts)
        const toRemove = ids.length - MAX_MESSAGES_PER_CHAT
        for (let i = 0; i < toRemove; i++) {
            delete next[sorted[i].k]
        }
    }
    return next
}

/**
 * Build a stateChange patch for `specialData.telegramMessagesByChatId[chatId]`
 * that records `entry`. The patch uses `undefined` sentinels for any
 * entries evicted by the cap so mergeSessionData deletes them.
 *
 * Return value is the inner per-chat map patch; callers wrap it under
 * `specialData.telegramMessagesByChatId[chatId]`.
 */
export function buildRecordPatch(existingChatMap, entry) {
    const newMap = applyMessageRecord(existingChatMap, entry)
    const patch = {}
    for (const k of Object.keys(existingChatMap ?? {})) {
        if (!(k in newMap)) {
            patch[k] = undefined
        }
    }
    const id = String(entry.id)
    patch[id] = newMap[id]
    return patch
}

/**
 * Direct-mutation helper for the outbound tooling. After a Grammy send
 * returns a Message object, call this with the normalized entry. The
 * function assigns a fresh `core.specialData` through the core setter
 * and schedules a debounced specialData persistence write.
 *
 * No-op if id or chatId is missing.
 */
export function recordOutboundMessage(core, entry) {
    if (!core || !entry || entry.id == null) {
        return
    }
    const chatId = String(entry.chatId ?? "")
    if (!chatId) {
        dbg("TG-STATE", "recordOutboundMessage: missing chatId")
        return
    }
    const full = {
        ...entry,
        id: String(entry.id),
        chatId,
        ts: entry.ts ?? Date.now(),
    }
    const byChat = core.specialData?.telegramMessagesByChatId ?? {}
    const existing = byChat[chatId] ?? {}
    const nextChat = applyMessageRecord(existing, full)
    core.specialData = {
        ...(core.specialData ?? {}),
        telegramMessagesByChatId: {
            ...byChat,
            [chatId]: nextChat,
        },
    }
    try {
        schedulePersist?.("specialData")
    } catch (e) {
        dbg("TG-STATE", "schedulePersist failed:", e)
    }
}

/**
 * Look up a recorded message by (chatId, messageId). Returns the
 * stored entry or null. Used by the reply-to router and by
 * getMessageBody() below.
 */
export function getMessage(core, chatId, messageId) {
    if (!core || chatId == null || messageId == null) {
        return null
    }
    const chatMap = core.specialData?.telegramMessagesByChatId?.[String(chatId)]
    return chatMap?.[String(messageId)] ?? null
}

/**
 * Return the recorded text body for a message, or null if unknown.
 * Thin convenience over `getMessage` for the common case.
 */
export function getMessageBody(core, chatId, messageId) {
    return getMessage(core, chatId, messageId)?.text ?? null
}
