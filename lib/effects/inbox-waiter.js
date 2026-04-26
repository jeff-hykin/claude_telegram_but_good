/**
 * lib/effects/inbox-waiter.js — event-driven wakeup for `cbg ask --sync`.
 *
 * When a CLI issues `ask_sync`, the daemon parks its IPC conn in
 * `core.inboxWaiters` keyed by the reply inbox address. When a reply
 * lands for that address (via tell_session inbox-only delivery), the
 * `notify_inbox_waiter` effect flushes the message down the parked
 * conn and closes it — no polling.
 *
 * The waiters map lives on `core` as a by-reference Map so patches
 * don't touch it (connections aren't serializable).
 */

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { encodeIpcFrame } = await versionedImport("../ipc.js", import.meta)

function getMap(core) {
    if (!core.inboxWaiters) {
        core.inboxWaiters = new Map()
    }
    return core.inboxWaiters
}

export function registerInboxWaiter(effect, core) {
    const { address, conn, targetSessionId } = effect
    if (!address || !conn) {
        dbg("INBOX-WAITER", "register: missing address or conn")
        return
    }
    const map = getMap(core)
    const existing = map.get(address)
    if (existing && existing.conn !== conn) {
        try {
            existing.conn.write(encodeIpcFrame({
                ok: false,
                error: `another waiter registered for inbox "${address}" — this one evicted`,
            }))
        } catch (e) {
            dbg("INBOX-WAITER", "evict-write failed:", e)
        }
        try {
            existing.conn.close()
        } catch (e) {
            dbg("INBOX-WAITER", "evict-close failed:", e)
        }
    }
    map.set(address, { conn, askedAt: Date.now(), targetSessionId: targetSessionId ?? null })
    dbg("INBOX-WAITER", `registered for ${address} (target=${targetSessionId ?? "-"})`)
}

export function failInboxWaitersForSession(effect, core) {
    const { sessionId, reason } = effect
    const map = core.inboxWaiters
    if (!map || !sessionId) { return }
    for (const [address, waiter] of map) {
        if (waiter.targetSessionId !== sessionId) { continue }
        try {
            waiter.conn.write(encodeIpcFrame({
                ok: false,
                error: `target session ${sessionId} ${reason ?? "died"} before replying`,
            }))
        } catch (e) {
            dbg("INBOX-WAITER", `fail-write for ${address}:`, e)
        }
        try {
            waiter.conn.close()
        } catch (e) {
            dbg("INBOX-WAITER", `fail-close for ${address}:`, e)
        }
        map.delete(address)
        dbg("INBOX-WAITER", `failed waiter for ${address} (target ${sessionId} ${reason ?? "died"})`)
    }
}

export async function notifyInboxWaiter(effect, core) {
    const { address, message } = effect
    const map = core.inboxWaiters
    if (!map) { return }
    const waiter = map.get(address)
    if (!waiter) { return }
    try {
        await waiter.conn.write(encodeIpcFrame({ ok: true, message }))
    } catch (e) {
        dbg("INBOX-WAITER", `notify-write failed for ${address}:`, e)
    }
    try {
        waiter.conn.close()
    } catch (e) {
        dbg("INBOX-WAITER", `notify-close failed for ${address}:`, e)
    }
    map.delete(address)
    dbg("INBOX-WAITER", `notified and cleared waiter for ${address}`)
}

export function clearInboxWaiterByConn(effect, core) {
    const { conn } = effect
    const map = core.inboxWaiters
    if (!conn || !map) { return }
    for (const [address, waiter] of map) {
        if (waiter.conn === conn) {
            map.delete(address)
            dbg("INBOX-WAITER", `cleared waiter for ${address} (conn closed)`)
        }
    }
}
