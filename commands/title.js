// commands/title.js — Action-returning hot command.
//
// Labels the focused session. Mutates via stateChanges instead of the
// legacy `state.setTitle(id, title)` imperative helper.

import { $ } from "../imports.js"
import { versionedImport } from "../lib/version.js"
const { loadAccess } = await versionedImport("../lib/access.js", import.meta)

export const tips = [
    "/title without any argument will auto-generate a title",
    "use /title &lt;name&gt; to label your claude sessions",
]

async function autoTitle(session) {
    const parts = []
    const dirName = session.cwd.split("/").filter(Boolean).pop() || session.cwd
    parts.push(dirName)
    let branch = session.gitBranch
    if (!branch) {
        try {
            branch = (await $`git rev-parse --abbrev-ref HEAD`
                .cwd(session.cwd)
                .timeout(3000)
                .stderr("null")
                .text()).trim()
        } catch (e) {
            // Best-effort — no branch detected.
        }
    }
    if (branch && branch !== "main" && branch !== "master") {
        parts.push(`(${branch})`)
    }
    return parts.join(" ")
}

export const descriptions = {
    title: "Label the focused session",
}

export const commands = {
    title: async (event, core) => {
        const access = loadAccess()
        const isCommandCenter = String(event.chatId) === String(access.commandCenterChatId ?? "")
        if (event.chatType !== "private" && !isCommandCenter) {
            return { effects: [] }
        }
        const senderId = String(event.userId ?? "")
        if (!isCommandCenter && !access.allowFrom.includes(senderId)) {
            return { effects: [] }
        }

        const text = event.text ?? ""
        let title = text.replace(/^\/title\s*/i, "").trim()

        // In command center, target the session bound to this topic
        let focused = null
        if (isCommandCenter && event.threadId) {
            const cc = core.chatState?.commandCenter ?? {}
            const sid = cc.threadMap?.[String(event.threadId)]
            if (sid) { focused = core.chatSessions?.[sid] ?? null }
        }
        if (!focused) {
            const focusedId = core.chatState?.focusedSessionId
            focused = focusedId ? core.chatSessions?.[focusedId] : null
        }
        if (!focused) {
            return {
                effects: [
                    { type: "send_text_to_user", chatId: event.chatId, text: "No focused session." },
                ],
            }
        }

        if (!title) {
            title = await autoTitle(focused)
        }

        return {
            stateChanges: {
                chatSessions: {
                    [focused.id]: { title },
                },
            },
            effects: [
                { type: "send_text_to_user", chatId: event.chatId, text: `Title: ${title}` },
            ],
        }
    },
}
