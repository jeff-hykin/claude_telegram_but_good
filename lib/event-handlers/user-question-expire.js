// ---------------------------------------------------------------------------
// user_question_expire handler.
//
// Armed when a question is asked, and re-armed on boot from the persisted
// record. A question that nobody tapped must not sit there forever: the
// buttons stop meaning anything, and — more importantly — whoever asked is
// entitled to learn that no answer is coming, especially a `cbg question
// --sync` conn parked on an inbox.
//
// Fires early? Re-arm. The record's expiresAt is the truth, not the timer.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { escapeMarkdown } = await versionedImport("../pure/markdown.js", import.meta)
const { buildAnswerPayload, expiredText, isExpired } = await versionedImport("../pure/user-questions.js", import.meta)
const { routeAnswer } = await versionedImport("../user-question-actions.js", import.meta)

export default function handle(event, core) {
    const { questionId } = event
    const record = core.chatState?.pendingQuestions?.[questionId]
    if (!record) {
        // Answered, cancelled, or already expired — all fine.
        return null
    }

    const now = event.ts ?? Date.now()
    if (!isExpired(record, now)) {
        const delayMs = Math.max(record.expiresAt - now, 1000)
        dbg("ASK-Q", `${questionId}: expiry fired early — re-arming in ${Math.round(delayMs / 1000)}s`)
        return {
            effects: [{ type: "set_timer", delayMs, event: { type: "user_question_expire", questionId } }],
        }
    }

    dbg("ASK-Q", `${questionId}: expired unanswered`)
    const payload = buildAnswerPayload(record, null, { now })
    const effects = routeAnswer(record, payload, core)
    if (record.messageId && record.chatId) {
        effects.push({
            type: "edit_telegram_message",
            chatId: record.chatId,
            messageId: record.messageId,
            text: expiredText(record, escapeMarkdown),
            options: { format: "markdown", reply_markup: { inline_keyboard: [] } },
        })
    }

    return {
        stateChanges: { chatState: { pendingQuestions: { [questionId]: undefined } } },
        effects,
    }
}
