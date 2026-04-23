// lib/event-handlers/scheduled-task-rehydrate.js
//
// One-shot event enqueued by main-server.js at startup for each
// non-terminal scheduled task. Emits a schedule_timer_set so the
// timer registry is repopulated after a restart.

import { versionedImport } from "../version.js"
const { dbg } = await versionedImport("../logging.js", import.meta)

export default function handle(event, _core) {
    const { chatId, scheduleTaskId, rule } = event
    if (!chatId || !scheduleTaskId || !rule) {
        dbg("SCHED-REHYDRATE", `missing fields on rehydrate event: ${JSON.stringify({ chatId, scheduleTaskId, hasRule: !!rule })}`)
        return null
    }
    return {
        effects: [
            { type: "schedule_timer_set", chatId, scheduleTaskId, rule, from: new Date().toISOString() },
        ],
    }
}
