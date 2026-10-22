/**
 * Decide which session a freshly booted shim is.
 *
 * Two sources claim to say: the shim's own environment (`CBG_SESSION_ID`,
 * set per-process by whichever spawner launched it) and the spawner's
 * handoff file `state/next_session.json`. Only one of them is safe. The
 * file is a single slot: the next spawn overwrites it, and a shim can take
 * 10-30 s to boot, so two sessions started seconds apart used to read each
 * other's entry and swap identities. The env cannot be raced, so it wins.
 *
 * `consumeSlot` says whether the caller should delete the handoff file. A
 * shim that took its identity from the env must leave a slot belonging to
 * someone else alone, or it strands the shim still booting.
 *
 * @param {{envId?: string|null, envTitle?: string|null, slot?: {id?: string, title?: string, dtachSocket?: string}|null}} sources
 * @returns {{id: string|null, title: string|null, dtachSocket: string|null, consumeSlot: boolean, source: "env"|"slot"|"none"}}
 */
export function resolveSessionIdentity({ envId, envTitle, slot } = {}) {
    if (envId) {
        const ours = slot?.id === envId
        return {
            id: envId,
            title: envTitle || (ours ? slot?.title ?? null : null),
            dtachSocket: ours ? slot?.dtachSocket ?? null : null,
            consumeSlot: ours,
            source: "env",
        }
    }
    if (slot?.id) {
        return {
            id: slot.id,
            title: slot.title ?? null,
            dtachSocket: slot.dtachSocket ?? null,
            consumeSlot: true,
            source: "slot",
        }
    }
    return { id: null, title: envTitle || null, dtachSocket: null, consumeSlot: true, source: "none" }
}

/**
 * Which live sessions are recorded against the wrong dtach socket.
 *
 * A mis-mapped session isn't noisy — it just quietly stops being reachable,
 * because every nudge and /peek types into whichever terminal the bad path
 * names. Nothing re-registers a session that is already connected, so the
 * bad entry survives a hot reload; `cbg reinstall` runs this to repair it in
 * place instead of costing that session its context.
 *
 * @param {Record<string, object>} chatSessions
 * @param {(pid: number) => string|null} resolveSocket - ancestry lookup, e.g. findDtachSocketStrict
 * @returns {Array<{id: string, from: string|null, to: string}>}
 */
export function planSocketRepairs(chatSessions, resolveSocket) {
    const repairs = []
    for (const [id, session] of Object.entries(chatSessions ?? {})) {
        const pid = session?.pid
        if (typeof pid !== "number" || pid <= 0) { continue }
        let actual = null
        try {
            actual = resolveSocket(pid)
        } catch (_) {
            continue
        }
        if (actual && actual !== session.dtachSocket) {
            repairs.push({ id, from: session.dtachSocket ?? null, to: actual })
        }
    }
    return repairs
}
