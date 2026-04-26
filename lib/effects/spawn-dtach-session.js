/**
 * lib/effects/spawn-dtach-session.js — spawn a fresh dtach-wrapped Claude
 * Code session.
 *
 * Performs the same sequence the `/refresh` and `/new` hot commands do
 * inline today (NEXT_SESSION_FILE write, .claude.json trust patch,
 * `dtach -n` spawn, background trust-prompt watcher, optional topic-dir
 * mkdir), packaged as an effect so cli-command handlers (in particular
 * `touch_session`) can request a spawn without doing subprocess work
 * themselves.
 *
 * The effect is best-effort: it logs and swallows spawn errors. Callers
 * should emit their own ipc_respond AFTER this effect to report the
 * projected session info — pid/connected fill in once the shim
 * registers (~1-3 s later).
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { $ } from "../../imports.js"
import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { paths } = await versionedImport("../paths.js", import.meta)

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
                } catch (e) { dbg("SPAWN-DTACH", "trust-prompt send failed:", e) }
                return
            }
        } catch (e) {
            dbg("SPAWN-DTACH", "trust-prompt poll error:", e)
        }
        setTimeout(poll, 500)
    }
    setTimeout(poll, 1000)
}

/**
 * Spawn a Claude Code session inside dtach.
 *
 * @param {object} effect
 * @param {string} effect.sessionId   — pre-assigned session id (PascalCase)
 * @param {string} [effect.title]     — display title for the session
 * @param {string} [effect.topicName] — if set, mkdir the topic memory
 *                                      directory so the session can write
 *                                      memory.md immediately
 */
export async function spawnDtachSession(effect, _core) {
    const { sessionId, title, topicName } = effect
    if (!sessionId) {
        dbg("SPAWN-DTACH", "missing sessionId, skipping")
        return
    }

    if (!(await $.commandExists("dtach"))) {
        dbg("SPAWN-DTACH", "dtach not installed, cannot spawn", sessionId)
        return
    }

    const dtachSock = paths.dtachSockFile(sessionId)
    const logFile = paths.dtachLogFile(sessionId)
    const home = Deno.env.get("HOME") ?? ""

    let permArgs = ""
    try {
        permArgs = readFileSync(paths.PERMISSION_ARGS_FILE, "utf8").trim()
    } catch (e) {
        dbg("SPAWN-DTACH", "no permission args file:", e)
    }
    const claudeCmd = `claude --no-tele ${permArgs} --channels plugin:telegram@claude-plugins-official`
        .replace(/  +/g, " ")
        .trim()

    const cleanEnv = { ...Deno.env.toObject() }
    for (const key of Object.keys(cleanEnv)) {
        if (key.startsWith("CLAUDE_") || key.startsWith("MCP_")) {
            delete cleanEnv[key]
        }
    }
    cleanEnv.SHELL = "/bin/bash"

    try {
        const claudeJsonPath = join(home, ".claude.json")
        const claudeJson = JSON.parse(readFileSync(claudeJsonPath, "utf8"))
        if (!claudeJson.projects) { claudeJson.projects = {} }
        if (!claudeJson.projects[home]) { claudeJson.projects[home] = {} }
        claudeJson.projects[home].hasTrustDialogAccepted = true
        writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2))
    } catch (e) {
        dbg("SPAWN-DTACH", "trust pre-accept failed:", e)
    }

    try {
        writeFileSync(paths.NEXT_SESSION_FILE, JSON.stringify({
            id: sessionId,
            title: title || undefined,
            dtachSocket: dtachSock,
        }))
    } catch (e) {
        dbg("SPAWN-DTACH", "NEXT_SESSION_FILE write failed:", e)
    }

    if (topicName) {
        try {
            mkdirSync(paths.topicDir(topicName), { recursive: true })
        } catch (e) {
            dbg("SPAWN-DTACH", "topic dir mkdir failed:", e)
        }
    }

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
        dbg("SPAWN-DTACH", `spawned ${sessionId} (title=${title ?? "-"} topic=${topicName ?? "-"})`)
    } catch (e) {
        dbg("SPAWN-DTACH", `dtach spawn failed for ${sessionId}:`, e)
    }
}
