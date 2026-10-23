// ---------------------------------------------------------------------------
// stale_chat_check handler.
//
// Emitted by tui-snapshot.js on every tick. For each command-center topic
// session that has gone stale (idle past its prompt-cache TTL — see
// lib/stale-chats.js), tells the topic what its next message will cost:
// "consume 137k tokens?". Once per idle stretch: `staleNotifiedFor` records
// the lastStopAt it was sent for, and any new turn moves lastStopAt on.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { isStaleSession, topicThreadKey } = await versionedImport("../stale-chats.js", import.meta)
const { backendForSession } = await versionedImport("../agent-backends/index.js", import.meta)
const { formatTokens } = await versionedImport("../pure/context-usage.js", import.meta)
const { replyToForSession, sendEffect } = await versionedImport("../pure/reply-to.js", import.meta)

export default async function handle(event, core) {
    const now = event.ts ?? Date.now()
    const sessionPatches = {}
    const effects = []

    for (const [sid, session] of Object.entries(core.chatSessions ?? {})) {
        if (!topicThreadKey(core, sid) || !isStaleSession(session, now) || session.staleNotifiedFor === session.lastStopAt) {
            continue
        }
        sessionPatches[sid] = { staleNotifiedFor: session.lastStopAt }
        let usage = null
        try {
            usage = await backendForSession(session).contextUsage({ session })
        } catch (e) {
            dbg("STALE", `contextUsage failed for ${sid}:`, e)
        }
        if (!usage?.ok) {
            dbg("STALE", `${sid} is stale but its context size is unknown (${usage?.detail ?? "error"}) — not asking`)
            continue
        }
        dbg("STALE", `${sid} stale — asking about ${usage.tokens} tokens`)
        effects.push(sendEffect(replyToForSession(sid, core, "stale-chat-check"), `consume ${formatTokens(usage.tokens)} tokens?`))
    }

    return Object.keys(sessionPatches).length > 0
        ? { stateChanges: { chatSessions: sessionPatches }, effects }
        : null
}
