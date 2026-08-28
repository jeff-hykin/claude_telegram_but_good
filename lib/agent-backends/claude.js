// ---------------------------------------------------------------------------
// lib/agent-backends/claude.js — Claude Code as an agent backend.
//
// This is the original (and until now, only) way cbg drives an agent:
// spawn the `claude` CLI inside a dtach-wrapped pty, then talk to it by
// typing into that pty as if a human were at the keyboard. Claude's own
// MCP shim and hook script handle the session-side half of the protocol
// (see spec.js) — this file is only the daemon-side half.
//
// Everything here was previously inlined in lib/effects/spawn-dtach-session.js
// and lib/effects/dtach-outbound.js; those modules now dispatch through the
// registry. Behavior is unchanged.
//
// Why typing into a TUI at all: Claude Code has no inbound API for "a new
// user message arrived" other than its channel notifications (which are
// request-scoped and can't start a turn). Injecting keystrokes is the only
// way to begin a turn from outside, which is why this backend needs a pty
// and the local one does not.
// ---------------------------------------------------------------------------

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { $ } from "../../imports.js"
import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { paths } = await versionedImport("../paths.js", import.meta)
const { defineBackend } = await versionedImport("./spec.js", import.meta)
const { typeIntoDtach } = await versionedImport("../dtach-inject.js", import.meta)
const { renderScreenFromLog } = await versionedImport("../pure/screen-render.js", import.meta)
const { parseTranscriptUsage, summarizeContext } = await versionedImport("../pure/context-usage.js", import.meta)

// Pause between the text write and the Enter write. Gives Ink's input loop
// time to process the text chunk and render the frame before the Enter
// arrives. If both writes land in the same read() on claude's side, Ink's
// paste heuristic coalesces them and the \r becomes a literal newline in
// the prompt buffer instead of a submit.
const SUBMIT_DELAY_MS = 120

// 0x0d (\r) is what a terminal sends for Return in raw mode; Ink treats it
// as submit provided it arrives on its own. 0x1b is ESC, which Claude Code
// uses to interrupt the current turn.
const ENTER_KEYSTROKE = new Uint8Array([0x0d])
const ESCAPE_KEYSTROKE = new Uint8Array([0x1b])

/**
 * Push raw bytes into an existing dtach session. dtach forwards them
 * straight to the pty master, so from claude's perspective they're
 * indistinguishable from keystrokes typed at an attached terminal.
 */
async function pushToDtach(dtachSocket, bytes) {
    const proc = new Deno.Command("dtach", {
        args: ["-p", dtachSocket],
        stdin: "piped",
        stdout: "null",
        stderr: "null",
    }).spawn()
    const writer = proc.stdin.getWriter()
    await writer.write(bytes)
    await writer.close()
    await proc.status
}

/**
 * Claude Code shows a "do you trust this folder?" prompt on first run in a
 * directory. We pre-accept it in ~/.claude.json, but that only covers
 * directories we know about ahead of time, so this watches the freshly
 * spawned session's screen for a few seconds and answers any prompt that
 * slips through.
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
                } catch (e) { dbg("BACKEND-CLAUDE", "trust-prompt send failed:", e) }
                return
            }
        } catch (e) {
            dbg("BACKEND-CLAUDE", "trust-prompt poll error:", e)
        }
        setTimeout(poll, 500)
    }
    setTimeout(poll, 1000)
}

async function spawn({ sessionId, title, topicName }) {
    if (!sessionId) {
        return { ok: false, detail: "missing sessionId" }
    }
    if (!(await $.commandExists("dtach"))) {
        return { ok: false, detail: "dtach is not installed" }
    }

    const dtachSock = paths.dtachSockFile(sessionId)
    const logFile = paths.dtachLogFile(sessionId)
    const home = Deno.env.get("HOME") ?? ""

    let permArgs = ""
    try {
        permArgs = readFileSync(paths.PERMISSION_ARGS_FILE, "utf8").trim()
    } catch (e) {
        dbg("BACKEND-CLAUDE", "no permission args file:", e)
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
        dbg("BACKEND-CLAUDE", "trust pre-accept failed:", e)
    }

    try {
        writeFileSync(paths.NEXT_SESSION_FILE, JSON.stringify({
            id: sessionId,
            title: title || undefined,
            dtachSocket: dtachSock,
        }))
    } catch (e) {
        dbg("BACKEND-CLAUDE", "NEXT_SESSION_FILE write failed:", e)
    }

    if (topicName) {
        try {
            mkdirSync(paths.topicDir(topicName), { recursive: true })
        } catch (e) {
            dbg("BACKEND-CLAUDE", "topic dir mkdir failed:", e)
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
        dbg("BACKEND-CLAUDE", `spawned ${sessionId} (title=${title ?? "-"} topic=${topicName ?? "-"})`)
        return { ok: true }
    } catch (e) {
        dbg("BACKEND-CLAUDE", `dtach spawn failed for ${sessionId}:`, e)
        return { ok: false, detail: `dtach spawn failed: ${e instanceof Error ? e.message : String(e)}` }
    }
}

async function sendUserText({ session, text }) {
    const dtachSocket = session?.dtachSocket
    if (!dtachSocket) {
        return { ok: false, detail: `no dtach socket for session ${session?.id}` }
    }
    try {
        // Step 1: the text alone — looks like pasted content to Ink.
        await pushToDtach(dtachSocket, new TextEncoder().encode(text))
        // Step 2: let Ink finish its render cycle.
        await new Promise((resolve) => setTimeout(resolve, SUBMIT_DELAY_MS))
        // Step 3: Enter as its own write, so Ink sees a keypress and not
        // a paste trailer.
        await pushToDtach(dtachSocket, ENTER_KEYSTROKE)
        dbg("BACKEND-CLAUDE", `injected text+Enter to ${session.id} (${text.length} chars)`)
        return { ok: true }
    } catch (e) {
        dbg("BACKEND-CLAUDE", `inject failed for ${session.id}:`, e)
        return { ok: false, detail: e instanceof Error ? e.message : String(e) }
    }
}

async function sendFiles({ session, filePaths }) {
    const dtachSocket = session?.dtachSocket
    if (!dtachSocket) {
        return { ok: false, detail: `no dtach socket for session ${session?.id}` }
    }
    // dtach is a text injection channel, not a file transfer protocol, so
    // hand over paths and let Claude read them with its own Read tool.
    for (const path of filePaths) {
        if (typeof path !== "string" || path.length === 0) {
            dbg("BACKEND-CLAUDE", `skipping invalid path entry: ${path}`)
            continue
        }
        try {
            await pushToDtach(dtachSocket, new TextEncoder().encode(`[file: ${path}]\n`))
            dbg("BACKEND-CLAUDE", `injected file marker for ${session.id}: ${path}`)
        } catch (e) {
            dbg("BACKEND-CLAUDE", `file marker inject failed for ${session.id} (${path}):`, e)
        }
    }
    return { ok: true }
}

async function sendRawInput({ session, text, submit = true, atomic = false }) {
    const dtachSocket = session?.dtachSocket
    if (!dtachSocket) {
        return { ok: false, detail: `no dtach socket for session ${session?.id}` }
    }
    if (typeof text !== "string") {
        return { ok: false, detail: "text must be a string" }
    }
    try {
        await typeIntoDtach(dtachSocket, text, { submit, atomic })
        dbg("BACKEND-CLAUDE", `injected raw input to ${session.id} (${text.length} chars, submit=${submit})`)
        return { ok: true }
    } catch (e) {
        dbg("BACKEND-CLAUDE", `raw input failed for ${session.id}:`, e)
        return { ok: false, detail: e instanceof Error ? e.message : String(e) }
    }
}

async function interrupt({ session }) {
    const dtachSocket = session?.dtachSocket
    if (!dtachSocket) {
        return { ok: false, detail: `no dtach socket for session ${session?.id}` }
    }
    try {
        await pushToDtach(dtachSocket, ESCAPE_KEYSTROKE)
        return { ok: true }
    } catch (e) {
        dbg("BACKEND-CLAUDE", `interrupt failed for ${session.id}:`, e)
        return { ok: false, detail: e instanceof Error ? e.message : String(e) }
    }
}

async function kill({ session }) {
    const pid = session?.pid
    if (typeof pid !== "number") {
        return { ok: false, detail: `no pid recorded for session ${session?.id}` }
    }
    try {
        Deno.kill(pid, "SIGTERM")
        return { ok: true }
    } catch (e) {
        dbg("BACKEND-CLAUDE", `kill failed for ${session.id}:`, e)
        return { ok: false, detail: e instanceof Error ? e.message : String(e) }
    }
}

async function readScreen({ session, width = 80, height = 50, historyStart = 3000 }) {
    // Fall back to deriving the log path from the id: a just-spawned
    // session has a log before its shim has registered a dtachSocket.
    const logFile = session?.dtachSocket
        ? session.dtachSocket.replace(/\.sock$/, ".log")
        : paths.dtachLogFile(session?.id)
    let raw
    try {
        raw = readFileSync(logFile, "utf8")
    } catch (e) {
        dbg("BACKEND-CLAUDE", `screen read failed for ${session?.id}:`, e)
        return { ok: false, detail: `no session log at ${logFile}` }
    }
    const { rendered, historyUsed, totalLines } = renderScreenFromLog(raw, { width, height, historyStart })
    return { ok: true, screen: rendered, historyUsed, totalLines }
}

// Transcripts run to tens of megabytes, and we only want the newest
// assistant entry, so we read a window off the end rather than the file.
// 256 KB covers dozens of entries even when tool results are large; the
// retry widens once for the rare turn that dwarfs that.
const TRANSCRIPT_TAIL_BYTES = 256 * 1024
const TRANSCRIPT_TAIL_BYTES_WIDE = 4 * 1024 * 1024

/** Read the last `byteCount` bytes of a file without loading the rest. */
function readTail(path, byteCount) {
    const file = Deno.openSync(path, { read: true })
    try {
        const size = file.statSync().size
        const start = Math.max(0, size - byteCount)
        file.seekSync(start, Deno.SeekMode.Start)
        const buffer = new Uint8Array(size - start)
        let filled = 0
        while (filled < buffer.length) {
            const read = file.readSync(buffer.subarray(filled))
            if (read === null || read === 0) { break }
            filled += read
        }
        return {
            text: new TextDecoder().decode(buffer.subarray(0, filled)),
            atLineStart: start === 0,
        }
    } finally {
        file.close()
    }
}

/**
 * How much context this session is currently carrying, read out of Claude
 * Code's own transcript. See lib/pure/context-usage.js for why the TUI's
 * "N% until auto-compact" is not used.
 */
async function contextUsage({ session }) {
    const transcriptPath = session?.transcriptPath
    if (typeof transcriptPath !== "string" || transcriptPath.length === 0) {
        return { ok: false, detail: "no transcript path recorded yet — the session has not finished a turn" }
    }
    if (!existsSync(transcriptPath)) {
        return { ok: false, detail: `transcript is gone: ${transcriptPath}` }
    }
    for (const byteCount of [TRANSCRIPT_TAIL_BYTES, TRANSCRIPT_TAIL_BYTES_WIDE]) {
        let tail
        try {
            tail = readTail(transcriptPath, byteCount)
        } catch (e) {
            dbg("BACKEND-CLAUDE", `transcript read failed for ${session?.id}:`, e)
            return { ok: false, detail: `could not read transcript: ${e instanceof Error ? e.message : String(e)}` }
        }
        const parsed = parseTranscriptUsage(tail.text, { atLineStart: tail.atLineStart })
        if (parsed.ok) {
            return { ok: true, ...parsed, ...summarizeContext(parsed), transcriptPath }
        }
        if (tail.atLineStart) {
            // Already read the whole file; a wider window can't help.
            return { ok: false, detail: parsed.detail }
        }
    }
    return { ok: false, detail: "no usage data found in transcript" }
}

async function healthCheck() {
    if (!(await $.commandExists("dtach"))) {
        return { ok: false, detail: "dtach is not installed" }
    }
    if (!(await $.commandExists("claude"))) {
        return { ok: false, detail: "the claude CLI is not on PATH" }
    }
    return { ok: true, detail: "claude + dtach available" }
}

export const backend = defineBackend({
    name: "claude",
    description: "Claude Code CLI running in a dtach-wrapped pty",
    capabilities: {
        rawInput: true,
        screen: true,
        slashCommands: true,
        login: true,
        permissionPrompts: true,
        interrupt: true,
        contextUsage: true,
    },
    spawn,
    sendUserText,
    sendFiles,
    sendRawInput,
    interrupt,
    kill,
    readScreen,
    contextUsage,
    healthCheck,
})
