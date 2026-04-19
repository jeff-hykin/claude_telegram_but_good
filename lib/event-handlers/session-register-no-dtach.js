// ---------------------------------------------------------------------------
// session_register_no_dtach handler.
//
// Emitted as a follow-up from session-register.js when the shim registered
// without a `dtach` process in its ancestry. This means /peek, /cancel,
// /pause, /resume cannot reach into that session's terminal — usually a
// symptom that the cbg claude shim got clobbered by a Claude Code update
// or a package-manager reinstall.
//
// Responsibilities:
//   - Log the warning to main.log.
//   - Mark chatState.noDtachWarnings[cwd] = now so we don't spam the user
//     with the same warning more than once per hour per cwd.
//   - Emit one `send_text_to_user` effect per pairing target, unless we
//     warned about the same cwd within the debounce window or the access
//     list is empty.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { loadAccess } = await versionedImport("../access.js", import.meta)
const { escapeHtml } = await versionedImport("../pure/html.js", import.meta)
const { makeReplyTo } = await versionedImport("../pure/reply-to.js", import.meta)

const DEBOUNCE_MS = 60 * 60 * 1000

export default function handle(event, core) {
    const sessionId = event.sessionId
    if (typeof sessionId !== "string") {
        dbg("SHIM-WARN", "invalid event, missing sessionId")
        return null
    }

    const cwd = event.cwd ?? "?"
    const gitBranch = event.gitBranch ?? "?"
    dbg("SHIM-WARN", `session ${sessionId} registered without dtach in ancestry (cwd=${cwd}, branch=${gitBranch})`)

    // Debounce: skip Telegram warning if we've already warned for this
    // cwd within the last hour. We still log every time so the failure
    // is traceable in main.log. The `lastWarnedAt > 0` guard matters:
    // with a fresh state map we don't want the first warning to be
    // suppressed just because `ts - 0 < DEBOUNCE_MS`.
    const warnings = core.chatState?.noDtachWarnings ?? {}
    const lastWarnedAt = warnings[cwd] ?? 0
    const now = event.ts ?? Date.now()
    if (lastWarnedAt > 0 && now - lastWarnedAt < DEBOUNCE_MS) {
        dbg("SHIM-WARN", `debounced Telegram warning for cwd=${cwd} (last warned ${now - lastWarnedAt}ms ago)`)
        return null
    }

    let access
    try {
        access = loadAccess()
    } catch (e) {
        dbg("SHIM-WARN", "loadAccess failed:", e)
        return null
    }
    const allowFrom = Array.isArray(access?.allowFrom) ? access.allowFrom : []
    if (allowFrom.length === 0) {
        dbg("SHIM-WARN", "no paired chats — skipping Telegram warning, logged only")
        return null
    }

    const text = [
        `⚠️ Session <code>${escapeHtml(sessionId)}</code> registered without dtach in its ancestry.`,
        `<b>cwd:</b> <code>${escapeHtml(cwd)}</code>`,
        `<b>branch:</b> <code>${escapeHtml(gitBranch)}</code>`,
        ``,
        `<i>/peek, /cancel, /pause, /resume won't work for it.</i>`,
        ``,
        `This usually means the cbg claude shim got clobbered — try <code>cbg reinstall</code>.`,
    ].join("\n")

    const effects = allowFrom.map((chatId) => ({
        type: "send_text_to_user",
        replyTo: makeReplyTo({ chatId, threadId: null, setBy: "session-register-no-dtach:warn" }),
        text,
        options: { parse_mode: "HTML" },
    }))

    return {
        stateChanges: {
            chatState: {
                noDtachWarnings: { [cwd]: now },
            },
        },
        effects,
    }
}
