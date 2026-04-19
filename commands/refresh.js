// commands/refresh.js — Action-returning hot command.
//
// Spawns a new Claude session in the current topic, binding it to the
// topic and feeding the last 50 messages as context.

import { writeFileSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { $ } from "../imports.js"
import { versionedImport } from "../lib/version.js"
const { loadAccess } = await versionedImport("../lib/access.js", import.meta)
const { dbg } = await versionedImport("../lib/logging.js", import.meta)
const { paths } = await versionedImport("../lib/paths.js", import.meta)
const { generateName } = await versionedImport("../lib/pure/ids.js", import.meta)
const { tailColdStream } = await versionedImport("../lib/cold-storage.js", import.meta)
const { replyToFromEvent } = await versionedImport("../lib/pure/reply-to.js", import.meta)

const CONTEXT_MESSAGE_LIMIT = 50

function gatherSessionContext(oldSessionId) {
    if (!oldSessionId) { return null }
    try {
        const all = tailColdStream("messages", 500)
        const sessionMsgs = all.filter(m => m.sessionId === oldSessionId && m.text)
        const recent = sessionMsgs.slice(-CONTEXT_MESSAGE_LIMIT)
        if (recent.length === 0) { return null }
        const lines = recent.map(m => {
            const who = m.from === "user" ? "User" : "Agent"
            const ts = m.ts ? new Date(m.ts).toISOString().slice(0, 16) : ""
            const text = (m.text ?? "").slice(0, 500)
            return `[${ts}] ${who}: ${text}`
        })
        return { count: recent.length, text: lines.join("\n\n") }
    } catch (e) {
        dbg("REFRESH", "gatherSessionContext failed:", e)
        return null
    }
}

export const descriptions = {
    refresh: "Spawn a new session in this topic",
}

function reply(replyTo, text) {
    return { effects: [{ type: "send_text_to_user", replyTo, text, options: { parse_mode: "HTML" } }] }
}

/**
 * After dtach spawns Claude, poll the log file for the "trust this
 * folder" prompt. If detected, send Enter to accept it.
 */
function watchForTrustPrompt(dtachSock, logFile, maxWaitMs = 15000) {
    const start = Date.now()
    const poll = async () => {
        if (Date.now() - start > maxWaitMs) { return }
        try {
            if (!existsSync(logFile)) {
                setTimeout(poll, 500)
                return
            }
            const raw = readFileSync(logFile, "utf8")
            const text = raw
                .replace(/\x1b\[\d*C/g, " ")
                .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
                .replace(/\x1b\[[0-9;?]*[a-zA-Z~]/g, "")
                .replace(/\x1b[>=<]/g, "")
                .replace(/\x1b[()][0-9A-Za-z]/g, "")
                .replace(/\x1b./g, "")
                .replace(/[\x00-\x08\x0e-\x1f\x7f]/g, "")
            if (/trust this folder|trust this project|Yes,?\s*I\s*trust/i.test(text)) {
                try {
                    await $`dtach -p ${dtachSock}`.stdinText("\n").timeout(3000)
                } catch (e) { dbg("REFRESH", "trust-prompt send failed:", e) }
                return
            }
        } catch (e) {
            dbg("REFRESH", "trust prompt poll error:", e)
        }
        setTimeout(poll, 500)
    }
    setTimeout(poll, 1000)
}

export const commands = {
    refresh: async (event, core) => {
        const access = loadAccess()
        const ccChatId = access.commandCenterChatId

        const replyTo = event._replyTo ?? replyToFromEvent(event, "cmd:refresh")

        if (!ccChatId || String(event.chatId) !== String(ccChatId)) {
            return reply(replyTo, "This command only works in the command center group.")
        }

        const threadId = event.threadId
        if (!threadId) {
            return reply(replyTo, "This command must be used inside a topic.")
        }

        if (!(await $.commandExists("dtach"))) {
            return reply(replyTo, "dtach not found. Install it with: brew install dtach / apt-get install dtach / nix profile install nixpkgs#dtach")
        }

        const cc = core.chatState?.commandCenter ?? {}
        const threadKey = String(threadId)

        // Determine title from the topic — use existing mapping or event context
        // For now use the text after /refresh as title, or fall back
        const titleFromCmd = event.text?.replace(/^\/refresh\s*/, "").trim()
        const existingSessionId = cc.threadMap?.[threadKey]
        const existingTitle = existingSessionId ? core.chatSessions?.[existingSessionId]?.title : null
        const title = titleFromCmd || existingTitle || `Topic${threadKey}`

        const sessionId = generateName()

        let permArgs = ""
        try {
            permArgs = readFileSync(paths.PERMISSION_ARGS_FILE, "utf8").trim()
        } catch (e) {
            dbg("REFRESH", "no permission args:", e)
        }
        const claudeCmd = `claude --no-tele ${permArgs} --channels plugin:telegram@claude-plugins-official`
            .replace(/  +/g, " ")
            .trim()
        const home = Deno.env.get("HOME") ?? ""
        const dtachSock = paths.dtachSockFile(sessionId)
        const logFile = paths.dtachLogFile(sessionId)

        const cleanEnv = { ...Deno.env.toObject() }
        for (const key of Object.keys(cleanEnv)) {
            if (key.startsWith("CLAUDE_") || key.startsWith("MCP_")) {
                delete cleanEnv[key]
            }
        }
        cleanEnv.SHELL = "/bin/bash"

        // Pre-accept workspace trust
        try {
            const claudeJsonPath = join(home, ".claude.json")
            const claudeJson = JSON.parse(readFileSync(claudeJsonPath, "utf8"))
            if (!claudeJson.projects) { claudeJson.projects = {} }
            if (!claudeJson.projects[home]) { claudeJson.projects[home] = {} }
            claudeJson.projects[home].hasTrustDialogAccepted = true
            writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2))
        } catch (e) {
            dbg("REFRESH", "trust pre-accept failed:", e)
        }

        writeFileSync(paths.NEXT_SESSION_FILE, JSON.stringify({
            id: sessionId,
            title: title,
            dtachSocket: dtachSock,
        }))

        try {
            const inner = `cd "${home}" && ${claudeCmd}`
            const isDarwin = Deno.build.os === "darwin"
            const cmd = isDarwin
                ? $`dtach -n ${dtachSock} -Ez script -q -F ${logFile} bash -c ${inner}`
                : $`dtach -n ${dtachSock} -Ez script -fq -c ${inner} ${logFile}`
            await cmd
                .clearEnv()
                .env(cleanEnv)
                .timeout(5000)
                .stdout("piped")
                .stderr("piped")

            // Gather context from the old session's message history
            const context = gatherSessionContext(existingSessionId)
            let contextFile = null
            if (context) {
                contextFile = join(paths.STATE_DIR, `refresh-context-${sessionId}.md`)
                const contextMd = [
                    `# Previous session context`,
                    ``,
                    `The following is the recent conversation history (last ${context.count} messages) from the previous session in this topic. Use it to understand what was being worked on.`,
                    ``,
                    context.text,
                ].join("\n")
                try {
                    writeFileSync(contextFile, contextMd)
                } catch (e) {
                    dbg("REFRESH", "failed to write context file:", e)
                    contextFile = null
                }
            }

            watchForTrustPrompt(dtachSock, logFile)

            // Update topic maps
            const topicMap = { ...(cc.topicMap ?? {}) }
            const threadMap = { ...(cc.threadMap ?? {}) }
            const topicNames = { ...(cc.topicNames ?? {}) }

            // Unbind old session if any
            if (existingSessionId) {
                delete topicMap[existingSessionId]
            }

            topicMap[sessionId] = threadKey
            threadMap[threadKey] = sessionId
            topicNames[threadKey] = title

            const contextNote = context
                ? `\nSending last ${context.count} messages for context.`
                : (existingSessionId
                    ? `\nNo message history found for previous session — starting fresh.`
                    : "")
            const effects = [{
                type: "send_text_to_user",
                replyTo,
                text: `Spawned new session <code>${sessionId}</code> (${title})${contextNote}`,
                options: { parse_mode: "HTML" },
            }]

            // Kill old session: send /exit gracefully, then schedule a
            // force-close as fallback in case it doesn't exit cleanly.
            if (existingSessionId) {
                const oldSession = core.chatSessions?.[existingSessionId]
                if (oldSession) {
                    effects.push({
                        type: "send_text_to_claude",
                        sessionId: existingSessionId,
                        text: "/exit",
                    })
                    effects.push({
                        type: "set_timer",
                        delayMs: 15000,
                        event: {
                            type: "session_force_close",
                            sessionId: existingSessionId,
                        },
                    })
                    dbg("REFRESH", `killing old session ${existingSessionId}`)
                }
            }

            // Queue context as a channel message so it's delivered
            // through the event queue when the session registers and
            // becomes focused — no dtach race with user messages.
            const messageQueue = [...(core.chatState?.messageQueue ?? [])]
            if (contextFile) {
                messageQueue.push({
                    content: `Read the file ${contextFile} for context from the previous session in this topic. Then briefly acknowledge what was being discussed and ask how you can help.`,
                    meta: { source: "refresh-context" },
                    queuedAt: Date.now(),
                })
                dbg("REFRESH", `queued context (${context.count} msgs) for ${sessionId}`)
            }

            return {
                stateChanges: {
                    chatState: {
                        pendingFocusId: sessionId,
                        messageQueue,
                        commandCenter: {
                            ...cc,
                            topicMap,
                            threadMap,
                            topicNames,
                        },
                    },
                },
                effects,
            }
        } catch (err) {
            let detail = ""
            if (err instanceof Error) {
                detail = err.message
                if (err.stderr) { detail += `\nstderr: ${err.stderr}` }
                if (err.stdout) { detail += `\nstdout: ${err.stdout}` }
            } else {
                detail = String(err)
            }
            dbg("REFRESH", "failed:", detail)
            return reply(replyTo, `Failed to spawn session:\n${detail}`)
        }
    },
}
