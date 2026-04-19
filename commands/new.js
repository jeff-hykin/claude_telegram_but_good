// commands/new.js — Action-returning hot command.
//
// Spawns a fresh dtach-wrapped Claude Code session with a pre-assigned
// session id, writes next_session.json so the new shim picks up the
// title/dtach socket on boot, and optionally flips focus to the new
// session after a short delay (via a follow-up `cli_command` event).
//
// The dtach spawn, trust-prompt watcher, and .claude.json edit all
// stay inline — they're orthogonal to the event loop and have no
// meaningful effect-layer analogues today.

import { writeFileSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { $ } from "../imports.js"
import { versionedImport } from "../lib/version.js"
const { loadAccess } = await versionedImport("../lib/access.js", import.meta)
const { dbg } = await versionedImport("../lib/logging.js", import.meta)
const { paths } = await versionedImport("../lib/paths.js", import.meta)
const { generateName } = await versionedImport("../lib/pure/ids.js", import.meta)
const { replyToFromEvent } = await versionedImport("../lib/pure/reply-to.js", import.meta)

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
                } catch (e) { dbg("NEW", "trust-prompt send failed:", e) }
                return
            }
        } catch (e) {
            // Not ready yet — keep polling.
        }
        setTimeout(poll, 500)
    }
    setTimeout(poll, 1000)
}

export const tips = [
    "/new &lt;name&gt; gives your session a title so it's easy to find later.",
    "Sessions launched with /new run headless — use /peek to see what they're doing.",
    "New sessions can be re-attached from the terminal with <code>cbg resume</code> when you're back at your computer.",
]

export const descriptions = {
    new: "Launch a new Claude Code session",
}

function reply(replyTo, text) {
    return { effects: [{ type: "send_text_to_user", replyTo, text }] }
}

export const commands = {
    new: async (event, core) => {
        if (event.chatType !== "private") { return { effects: [] } }
        const access = loadAccess()
        if (!access.allowFrom.includes(String(event.userId ?? ""))) {
            return { effects: [] }
        }

        const replyTo = event._replyTo ?? replyToFromEvent(event, "cmd:new")

        if (!(await $.commandExists("dtach"))) {
            return reply(replyTo, "dtach not found. Install it with: brew install dtach / apt-get install dtach / nix profile install nixpkgs#dtach")
        }

        const sessionId = generateName()
        const title = event.text?.replace(/^\/new\s*/, "").trim() || undefined

        let permArgs = ""
        try {
            permArgs = readFileSync(paths.PERMISSION_ARGS_FILE, "utf8").trim()
        } catch (e) {
            // no permission config — use defaults
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

        // Pre-accept the workspace trust dialog for the target directory
        try {
            const claudeJsonPath = join(home, ".claude.json")
            const claudeJson = JSON.parse(readFileSync(claudeJsonPath, "utf8"))
            if (!claudeJson.projects) { claudeJson.projects = {} }
            if (!claudeJson.projects[home]) { claudeJson.projects[home] = {} }
            claudeJson.projects[home].hasTrustDialogAccepted = true
            writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2))
        } catch (e) {
            // Best-effort — watchForTrustPrompt is the fallback.
        }

        writeFileSync(paths.NEXT_SESSION_FILE, JSON.stringify({
            id: sessionId,
            title: title || undefined,
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

            watchForTrustPrompt(dtachSock, logFile)

            const displayTitle = title ? ` (${title})` : ""
            // The new shim will register in ~1 s. Stash the session id
            // as `pendingFocusId` so `session_register` promotes it to
            // focused when the registration lands. This replaces the
            // legacy setTimeout → state.setFocusedSession dance.
            return {
                stateChanges: {
                    chatState: { pendingFocusId: sessionId },
                },
                effects: [
                    {
                        type: "send_text_to_user",
                        replyTo,
                        text: `Created: /chat_${sessionId}${displayTitle}`,
                    },
                ],
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
            dbg("NEW", "failed:", detail)
            return reply(replyTo, `Failed to create new session via dtach:\n${detail}`)
        }
    },
}
