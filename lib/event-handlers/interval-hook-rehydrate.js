// lib/event-handlers/interval-hook-rehydrate.js
//
// One-shot event enqueued by main-server.js at startup for each active
// interval hook. Emits an interval_hook_timer_set so the shared timer
// registry is repopulated after a restart.

import { versionedImport } from "../version.js"
const { dbg } = await versionedImport("../logging.js", import.meta)

export default function handle(event, _core) {
    const { chatId, hookId, rule } = event
    if (!chatId || !hookId || !rule) {
        dbg("IHOOK-REHYDRATE", `missing fields: ${JSON.stringify({ chatId, hookId, hasRule: !!rule })}`)
        return null
    }
    return {
        effects: [
            { type: "interval_hook_timer_set", chatId, hookId, rule, from: new Date().toISOString() },
        ],
    }
}
