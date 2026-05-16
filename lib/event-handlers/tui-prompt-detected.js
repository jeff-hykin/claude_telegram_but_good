// ---------------------------------------------------------------------------
// tui_prompt_detected handler.
//
// Fired by tui-snapshot.js when the TUI prompt detector finds a
// blocking prompt on a session's screen. Auto-answers safe prompts
// (file creation, trust folder) by injecting keystrokes via dtach.
// Forwards ambiguous prompts to Telegram so the user can decide.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { escapeMarkdown: esc } = await versionedImport("../pure/markdown.js", import.meta)
const { replyToForSession, sendEffect } = await versionedImport("../pure/reply-to.js", import.meta)
const { loadAccess } = await versionedImport("../access.js", import.meta)

export default function handle(event, core) {
    const { sessionId, prompt } = event
    if (!sessionId || !prompt) {
        dbg("TUI-PROMPT", "invalid event — missing sessionId or prompt")
        return null
    }

    const session = core.chatSessions?.[sessionId]
    if (!session) {
        dbg("TUI-PROMPT", `session ${sessionId} gone — skipping`)
        return null
    }

    // Deduplicate: don't re-answer a prompt we've already handled.
    // Track the last prompt type + file answered per session.
    const promptKey = `${prompt.type}:${prompt.file ?? ""}`
    if (session._lastPromptHandled === promptKey) {
        dbg("TUI-PROMPT", `already handled ${promptKey} for ${sessionId} — skipping`)
        return null
    }

    const effects = []

    const access = loadAccess()
    const fallbackChatId = access.commandCenterChatId || (access.allowFrom?.[0])
    const replyTo = replyToForSession(sessionId, core, "tui-prompt-detected", fallbackChatId)

    if (prompt.autoAnswer) {
        // Safe to auto-answer — inject the keypress via dtach.
        dbg("TUI-PROMPT", `auto-answering ${prompt.type} for ${sessionId}: "${prompt.autoAnswer}"`)
        effects.push({
            type: "send_text_to_claude",
            sessionId,
            text: prompt.autoAnswer,
        })

        // Notify the user what we did (informational, not blocking).
        if (replyTo.chatId) {
            const detail = prompt.file
                ? ` (\`${esc(prompt.file)}\`)`
                : ""
            effects.push(sendEffect(
                replyTo,
                `Auto-answered TUI prompt: _${esc(prompt.type)}${detail}_`,
                { parse_mode: "Markdown" },
            ))
        }
    } else {
        // Ambiguous prompt — forward to Telegram for the user to handle.
        dbg("TUI-PROMPT", `forwarding ${prompt.type} to user for ${sessionId}`)
        if (replyTo.chatId) {
            effects.push(sendEffect(
                replyTo,
                `⚠️ Session \`${esc(sessionId)}\` is blocked on a TUI prompt: *${esc(prompt.type)}*\n` +
                `The session needs manual intervention (attach via terminal or /cancel + restart).`,
                { parse_mode: "Markdown" },
            ))
        }
    }

    return {
        stateChanges: {
            chatSessions: {
                [sessionId]: { _lastPromptHandled: promptKey },
            },
        },
        effects,
    }
}
