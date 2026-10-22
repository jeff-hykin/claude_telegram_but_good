// ---------------------------------------------------------------------------
// ask_user_question handler.
//
// The one place a button question is created, whoever asked:
//
//   - a Claude session       → the `ask_user_question` MCP tool, which
//                              dispatches through claude-channel.js
//   - a slash command        → `followUpEvents: [{ type: "ask_user_question",
//                              ... }]`, which needs no imports and therefore
//                              works from a custom command outside the repo
//   - anything else          → `cbg question` on the CLI
//
// Event shape:
//   {
//       type: "ask_user_question",
//       questionId?,        // pre-generated when the asker was handed the id
//       question, options,  // options: ["Keep","Drop"] or [{key,label}]
//       context?,           // one short line of detail
//       answerTo?,          // "session:X" | "topic:Y" | "inbox:Z"
//       ttlSeconds?,
//       chatId?, threadId?, // where to ASK; defaults to the asker's topic
//       askedBy?: { kind: "session"|"command"|"cli", id },
//       _conn?, requestId?, // present when a caller is waiting on an IPC reply
//   }
//
// Errors go back over IPC when someone is waiting, and into the chat
// otherwise — a malformed question must never fail silently, because the
// asker may be blocked on an answer that is never coming.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { buildAskAction } = await versionedImport("../user-question-actions.js", import.meta)

export default function handle(event, core) {
    const built = buildAskAction(event, core)

    if (built.error) {
        dbg("ASK-Q", `rejected: ${built.error}`)
        return { stateChanges: {}, effects: errorEffects(event, built.error) }
    }

    dbg("ASK-Q", `${built.questionId}: "${event.question}" (${event.options?.length ?? 0} options) → ${event.answerTo ?? "asker"}`)

    const effects = [...built.action.effects]
    if (event._conn && event.requestId) {
        effects.unshift({
            type: "ipc_respond",
            conn: event._conn,
            message: {
                ok: true,
                requestId: event.requestId,
                questionId: built.questionId,
                expiresAt: built.expiresAt,
            },
            closeAfter: event.closeConnAfter ?? false,
        })
    }
    return { ...built.action, effects }
}

function errorEffects(event, error) {
    if (event._conn && event.requestId) {
        return [{
            type: "ipc_respond",
            conn: event._conn,
            message: { ok: false, requestId: event.requestId, error },
            closeAfter: event.closeConnAfter ?? false,
        }]
    }
    if (event.chatId) {
        return [{
            type: "send_text_to_user",
            chatId: event.chatId,
            text: `⚠️ could not ask that question: ${error}`,
            options: { format: "plain", ...(event.threadId != null ? { message_thread_id: Number(event.threadId) } : {}) },
        }]
    }
    return []
}
