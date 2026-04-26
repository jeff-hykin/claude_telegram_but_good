/**
 * lib/pure/target-resolver.js — parse + resolve `tell_session` / `ask_sync`
 * target addresses.
 *
 * Accepts either a bare address (legacy fuzzy resolution — session ID →
 * topic → title substring) or a prefixed address that says exactly which
 * lookup to use:
 *
 *     session:<id>   exact session ID, errors if not found
 *     topic:<name>   exact topic name, errors if not found or ambiguous
 *     title:<sub>    title substring, errors if not found or ambiguous
 *     inbox:<addr>   never a session — caller writes to this inbox directly
 *     cbg:<x>        shorthand for "auto" — disambiguates from non-cbg
 *                    targets in natural-language prompts ("tell cbg:arduino
 *                    ..." vs "tell the actual arduino device ...")
 *     <bare>         legacy auto mode: session ID → topic → title
 *
 * Unknown prefixes (e.g. a colon in a session ID that's not one of the
 * above) fall through to auto mode with the ORIGINAL raw string so a
 * session accidentally named "foo:bar" still resolves.
 *
 * Pure. Depends on nothing but the caller's `sessions` + `commandCenter`
 * slices. Tested directly in tests/pure-target-resolver-test.js.
 */

export const TARGET_PREFIXES = ["session", "topic", "title", "inbox", "cbg"]

/**
 * @param {string} raw
 * @returns {{ mode: "session"|"topic"|"title"|"inbox"|"auto", value: string }}
 */
export function parseTargetAddress(raw) {
    if (typeof raw !== "string" || raw.length === 0) {
        return { mode: "auto", value: raw ?? "" }
    }
    const m = /^([a-z]+):(.*)$/i.exec(raw)
    if (!m) { return { mode: "auto", value: raw } }
    const prefix = m[1].toLowerCase()
    const value = m[2]
    if (prefix === "session") { return { mode: "session", value } }
    if (prefix === "topic")   { return { mode: "topic", value } }
    if (prefix === "title")   { return { mode: "title", value } }
    if (prefix === "inbox")   { return { mode: "inbox", value } }
    if (prefix === "cbg")     { return { mode: "auto", value } }
    return { mode: "auto", value: raw }
}

/**
 * Resolve a parsed address against the current session set.
 *
 * Returns one of:
 *   { session }            — found a live session (explicit or auto match)
 *   { inbox }              — caller should route to this inbox address, no
 *                            session attempt (only from `inbox:<addr>`)
 *   { error }              — resolution failed; for `auto` mode the caller
 *                            MAY fall back to inbox-only with the raw value
 *
 * @param {string} raw
 * @param {object} core  — must expose `chatSessions` and `chatState.commandCenter`
 */
export function resolveTarget(raw, core) {
    const { mode, value } = parseTargetAddress(raw)
    const sessions = core.chatSessions ?? {}
    const cc = core.chatState?.commandCenter ?? {}

    if (mode === "inbox") {
        if (!value) { return { error: "inbox: address is empty" } }
        return { inbox: value }
    }

    if (mode === "session") {
        const s = sessions[value]
        if (s?._conn) { return { session: s } }
        return { error: `no connected session with ID "${value}"` }
    }

    if (mode === "topic") {
        return resolveByTopic(value, sessions, cc)
    }

    if (mode === "title") {
        return resolveByTitle(value, sessions)
    }

    // auto: session → topic → title (legacy behavior, ambiguities surface early)
    if (sessions[value]?._conn) { return { session: sessions[value] } }

    const byTopic = resolveByTopic(value, sessions, cc)
    if (byTopic.session) { return byTopic }
    if (byTopic.ambiguous) { return byTopic }

    const byTitle = resolveByTitle(value, sessions)
    if (byTitle.session) { return byTitle }
    if (byTitle.ambiguous) { return byTitle }

    return { error: `no connected session matches "${value}" (tried session ID, topic name, title)` }
}

function resolveByTopic(value, sessions, cc) {
    const matches = []
    for (const [, s] of Object.entries(sessions)) {
        if (!s?._conn) { continue }
        const threadId = cc.topicMap?.[s.id] ?? null
        const topicName = threadId ? (cc.topicNames?.[threadId] ?? null) : null
        if (topicName && topicName.toLowerCase() === value.toLowerCase()) {
            matches.push(s)
        }
    }
    if (matches.length === 1) { return { session: matches[0] } }
    if (matches.length > 1) {
        const ids = matches.map(s => s.id).join(", ")
        return { ambiguous: true, error: `ambiguous: ${matches.length} sessions in topic "${value}" (${ids}). Use session:<ID>.` }
    }
    return { error: `no connected session in topic "${value}"` }
}

function resolveByTitle(value, sessions) {
    const needle = value.toLowerCase()
    const matches = []
    for (const [, s] of Object.entries(sessions)) {
        if (!s?._conn) { continue }
        if (s.title && s.title.toLowerCase().includes(needle)) {
            matches.push(s)
        }
    }
    if (matches.length === 1) { return { session: matches[0] } }
    if (matches.length > 1) {
        const ids = matches.map(s => `${s.id} (${s.title})`).join(", ")
        return { ambiguous: true, error: `ambiguous: ${matches.length} sessions match title "${value}" (${ids}). Use session:<ID>.` }
    }
    return { error: `no connected session with title matching "${value}"` }
}
