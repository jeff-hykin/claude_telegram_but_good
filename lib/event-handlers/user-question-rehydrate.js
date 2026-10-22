// lib/event-handlers/user-question-rehydrate.js
//
// One-shot event enqueued by main-server.js at startup for each pending
// button question. The question ITSELF survives a restart on its own — the
// registry lives in chatState and the callback handler reads state, so the
// buttons keep working — but its expiry timer was an in-memory setTimeout,
// and without re-arming it a question nobody taps would hang around forever
// and its asker would never learn that no answer is coming.

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { expiryDelayMs } = await versionedImport("../pure/user-questions.js", import.meta)

export default function handle(event, core) {
    const { questionId } = event
    const record = core.chatState?.pendingQuestions?.[questionId]
    if (!record) {
        dbg("ASK-Q", `rehydrate ${questionId}: no record`)
        return null
    }
    const delayMs = expiryDelayMs(record)
    dbg("ASK-Q", `rehydrate ${questionId}: expiry re-armed in ${Math.round(delayMs / 1000)}s`)
    return {
        effects: [
            { type: "set_timer", delayMs, event: { type: "user_question_expire", questionId } },
        ],
    }
}
