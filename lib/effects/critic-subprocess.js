/**
 * Spawn a claude -p critic subprocess for a long task.
 *
 * The effect handler returns immediately after spawning. When the
 * subprocess completes, it enqueues a `critic_verdict` event with
 * the outcome so the normal event-loop flow can process it.
 */

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { join } = await versionedImport("../../imports.js", import.meta)
const { paths } = await versionedImport("../paths.js", import.meta)
const { getCriticModel, getCriticFallbackModel } = await versionedImport("../config-manager.js", import.meta)

// Static prefix of the critic prompt. The actual per-task prompt
// appends the embedded context.md / definition_of_done.md / report.md
// contents — pre-reading those files and inlining them saves ~3 Read
// tool calls per critic run and noticeably speeds up the cycle.
const CRITIC_PROMPT_PREFIX = `You are the critic for a long-running task. Your job is to independently verify whether the worker's report satisfies the definition of done.

The worker wrote the definition of done before starting work and cannot modify it now. They submitted a report claiming the work is complete. Your job is to verify that claim against the locked definition.

The three key files are embedded below. You do NOT need to Read them again. The task directory is also on --add-dir so you can read any files the report references, run tests, builds, linters, or any other verification commands needed to confirm the work is actually done. Take as long as you need — thoroughness matters more than speed.

What you should do is entirely determined by the definition of done. If the definition says tests must pass, run the tests yourself. If it says code must be reviewed, read the code. If it says a file must exist, check it. Use your judgment for anything the definition doesn't explicitly cover.

Do your best with the definition you have, even if it's vague. A vague definition still means something — use your judgment. If the definition is legitimately ambiguous, pick the most defensible reading, note the assumption you made, and judge against that — do NOT ask for clarification. The user is not present during this run; you only get to produce revision notes the worker can action alone. Anything you ask would be ignored.

OUTPUT FORMAT (critical, parsed by a regex — NO deviation):
The VERY FIRST CHARACTERS of your response MUST be one of these two exact tokens, on their own line, with the colon, nothing before them:
  Accepted:
  Revisions:

Then a blank line, then the body of your judgment.

Do NOT start with any preamble, reasoning, "Let me…", "Based on…", headings, checklists, thinking, or commentary. The first 10 characters of your response are parsed by /^(Accepted|Revisions):/ — anything else produces an indecisive verdict and forces a retry.

Template for an accepted report:
---
Accepted:

- Criterion 1: <met, evidence>
- Criterion 2: <met, evidence>
- …
---

Template for a revision request:
---
Revisions:

1. <concrete fix the worker can do alone>
2. <another concrete fix>
- …
---

Body content guidelines:
  - After "Accepted:" — a concise checklist mapping each done-condition criterion to the concrete evidence you verified.
  - After "Revisions:" — a list of concrete fixes the worker must make, written as direct instructions the worker can follow alone. Be specific about what's missing and how to close each gap.

Do NOT use the Write tool — the system parses your stdout and writes the result file for you. Do NOT produce both tokens. Do NOT skip the token. Do NOT put anything before the token on line 1.

REMINDER: your response MUST start with exactly "Accepted:" or "Revisions:" as the very first word. Nothing before it.`

function readFileOrPlaceholder(path, label) {
    try {
        const content = Deno.readTextFileSync(path)
        return `\n\n===== ${label} (${path}) =====\n${content}\n===== end ${label} =====`
    } catch (e) {
        if (e instanceof Deno.errors.NotFound) {
            return `\n\n===== ${label} (${path}) =====\n[NOT PRESENT ON DISK]\n===== end ${label} =====`
        }
        dbg("CRITIC-SUB", `read ${label} failed:`, e)
        return `\n\n===== ${label} (${path}) =====\n[READ ERROR: ${String(e).slice(0, 200)}]\n===== end ${label} =====`
    }
}

function buildCriticPrompt(dir) {
    const parts = [
        CRITIC_PROMPT_PREFIX,
        `\n\nTask directory: ${dir}`,
        readFileOrPlaceholder(join(dir, "definition_of_done.md"), "definition_of_done.md"),
        readFileOrPlaceholder(join(dir, "context.md"), "context.md"),
        readFileOrPlaceholder(join(dir, "report.md"), "report.md"),
    ]
    return parts.join("")
}

/**
 * Parse the critic's stdout into a verdict + body. Expects the
 * response to start with either "Accepted:" or "Revisions:" on the
 * first non-empty line. Returns { verdict, body } where verdict is
 * "certified" / "revisions" / "indecisive" (if neither prefix found).
 */
function parseCriticStdout(stdout) {
    const trimmed = (stdout ?? "").replace(/^\s+/, "")
    const accepted = /^Accepted\s*:\s*\n?/i.exec(trimmed)
    if (accepted) {
        return { verdict: "certified", body: trimmed.slice(accepted[0].length).trim() }
    }
    const revisions = /^Revisions?\s*:\s*\n?/i.exec(trimmed)
    if (revisions) {
        return { verdict: "revisions", body: trimmed.slice(revisions[0].length).trim() }
    }
    return { verdict: "indecisive", body: trimmed }
}

/**
 * When the critic's response is substantive but doesn't follow the
 * required format, do a cheap reformat call: feed the original output
 * to a fast model and ask it to reply with just "Accepted:" or
 * "Revisions:" followed by the content. This avoids re-running the
 * full analysis while still forcing correct output format.
 */
async function reformatCriticOutput(originalStdout, logLabel) {
    const prompt = `The following is a critic's analysis of whether a task meets its definition of done. The critic forgot to start with the required prefix. Please re-output the critic's response, but starting with exactly "Accepted:" or "Revisions:" on the first line (whichever matches the critic's intent), followed by a blank line, then the rest of the critic's analysis verbatim.

Do NOT re-analyze. Do NOT add commentary. Just determine whether the critic accepted or requested revisions, then re-output with the correct prefix.

--- CRITIC OUTPUT ---
${originalStdout}
--- END ---

Your response must start with exactly "Accepted:" or "Revisions:" as the very first word.`

    dbg("CRITIC-SUB", `reformat pass for ${logLabel} (${originalStdout.length}B original)`)

    const cleanEnv = { ...Deno.env.toObject() }
    for (const key of Object.keys(cleanEnv)) {
        if (key.startsWith("CLAUDE_") || key.startsWith("MCP_")) {
            delete cleanEnv[key]
        }
    }

    try {
        const child = new Deno.Command("claude", {
            args: [
                "-p", prompt,
                "--model", "sonnet",
                "--no-session-persistence",
                "--strict-mcp-config",
                "--dangerously-skip-permissions",
            ],
            env: cleanEnv,
            clearEnv: true,
            stdout: "piped",
            stderr: "piped",
        }).spawn()

        const chunks = []
        const drainStdout = (async () => {
            try { for await (const chunk of child.stdout) { chunks.push(chunk) } }
            catch (e) { dbg("CRITIC-SUB", `reformat drain stdout:`, e) }
        })()
        // Drain stderr but discard
        const drainStderr = (async () => {
            try { for await (const chunk of child.stderr) { /* discard */ } }
            catch (e) { dbg("CRITIC-SUB", `reformat drain stderr:`, e) }
        })()

        // 60s timeout — this should be very fast (no tool use, just reformatting)
        const status = await Promise.race([
            child.status,
            new Promise((_, reject) => setTimeout(() => reject(new Error("reformat timeout")), 60_000)),
        ])

        await Promise.race([drainStdout, new Promise(r => setTimeout(r, 500))])
        await Promise.race([drainStderr, new Promise(r => setTimeout(r, 500))])

        const decoder = new TextDecoder()
        const reformatted = chunks.map(c => decoder.decode(c, { stream: false })).join("")
        const parsed = parseCriticStdout(reformatted)

        if (parsed.verdict !== "indecisive") {
            dbg("CRITIC-SUB", `reformat succeeded: ${parsed.verdict} (${logLabel})`)
            return parsed
        }

        dbg("CRITIC-SUB", `reformat still indecisive (${logLabel}): ${reformatted.slice(0, 100)}`)
        return null
    } catch (e) {
        dbg("CRITIC-SUB", `reformat failed (${logLabel}):`, e)
        return null
    }
}

function fileExists(path) {
    try {
        Deno.statSync(path)
        return true
    } catch (e) {
        if (e instanceof Deno.errors.NotFound) {
            return false
        }
        dbg("CRITIC-SUB", "fileExists check failed:", e)
        return false
    }
}

/**
 * Find the task in specialData and return its metadata, or null.
 */
function findTask(specialData, taskId) {
    const byChat = specialData?.longTaskByChatId ?? {}
    for (const [chatId, tasks] of Object.entries(byChat)) {
        if (tasks && tasks[taskId] !== undefined) {
            return { chatId, task: tasks[taskId] }
        }
    }
    return null
}

/**
 * Compute the on-disk task directory for a given task id.
 * Tasks live under paths.LONG_TASKS_DIR/<taskId>/.
 */
function taskDir(taskId) {
    return paths.longTaskDir(taskId)
}

/**
 * Dir-scoped critic runner — spawn claude -p, watch stdout for
 * Accepted:/Revisions: prefix, write the result file, flush logs,
 * return the verdict. Caller is responsible for shaping + enqueueing
 * the `critic_verdict` event (long-task wants a taskId, scheduled-run
 * wants a scheduledRun wrapper).
 *
 * Pre-conditions: `dir` already contains a `definition_of_done.md`
 * and `report.md`. `dir` is the directory the critic will Read from
 * and the one its `--add-dir` will be pinned to.
 *
 * Returns { verdict, details, elapsedMs }.
 */
async function runCriticCore({ dir, attempt, logLabel }) {
    const start = Date.now()
    const prompt = buildCriticPrompt(dir)
    const model = getCriticModel()
    const fallbackModel = getCriticFallbackModel()
    dbg("CRITIC-SUB", `runCriticCore model=${model} fallback=${fallbackModel} dir=${dir}`)
    const args = [
        "-p", prompt,
        "--model", model,
        "--fallback-model", fallbackModel,
        "--no-session-persistence",
        "--strict-mcp-config",
        "--add-dir", dir,
        "--dangerously-skip-permissions",
    ]
    const cleanEnv = { ...Deno.env.toObject() }
    for (const key of Object.keys(cleanEnv)) {
        if (key.startsWith("CLAUDE_") || key.startsWith("MCP_")) {
            delete cleanEnv[key]
        }
    }

    const HARD_TIMEOUT_MS = attempt === 1 ? 600_000 : attempt === 2 ? 1_200_000 : Infinity
    const POLL_MS = 500
    const STDOUT_QUIET_MS = 3_000

    const certPath = join(dir, "certification.md")
    const revPath = join(dir, "requested_revisions.md")
    const logPath = join(dir, `critic_output.attempt${attempt}.log`)

    if (attempt === 1) {
        try { Deno.removeSync(join(dir, "critic_output.log")) }
        catch (e) {
            if (!(e instanceof Deno.errors.NotFound)) {
                dbg("CRITIC-SUB", `remove stale critic_output.log:`, e)
            }
        }
    }

    let verdict = "error"
    let details = ""
    let child = null
    const stdoutChunks = []
    const stderrChunks = []
    try {
        child = new Deno.Command("claude", {
            args,
            env: cleanEnv,
            clearEnv: true,
            stdout: "piped",
            stderr: "piped",
        }).spawn()

        const drainStdout = (async () => {
            try { for await (const chunk of child.stdout) { stdoutChunks.push(chunk) } }
            catch (e) { dbg("CRITIC-SUB", `drain stdout (${logLabel}):`, e) }
        })()
        const drainStderr = (async () => {
            try { for await (const chunk of child.stderr) { stderrChunks.push(chunk) } }
            catch (e) { dbg("CRITIC-SUB", `drain stderr (${logLabel}):`, e) }
        })()
        child._drainStdout = drainStdout
        child._drainStderr = drainStderr

        const begin = Date.now()
        let exited = false
        let lastStdoutBytes = 0
        let lastStdoutChangeAt = 0
        const stdoutBytes = () => stdoutChunks.reduce((s, c) => s + c.byteLength, 0)
        const statusPromise = child.status
            .then((s) => { exited = true; return s })
            .catch(() => { exited = true; return null })

        while (!exited) {
            if (Date.now() - begin > HARD_TIMEOUT_MS) {
                dbg("CRITIC-SUB", `hard timeout (${logLabel}); will kill`)
                break
            }
            const n = stdoutBytes()
            if (n !== lastStdoutBytes) { lastStdoutBytes = n; lastStdoutChangeAt = Date.now() }
            if (n > 0 && lastStdoutChangeAt > 0 && Date.now() - lastStdoutChangeAt > STDOUT_QUIET_MS) {
                dbg("CRITIC-SUB", `stdout stable at ${n}B (${logLabel}); will kill`)
                break
            }
            await Promise.race([statusPromise, new Promise((r) => setTimeout(r, POLL_MS))])
        }

        if (!exited) {
            try { child.kill("SIGKILL") }
            catch (e) { dbg("CRITIC-SUB", `SIGKILL (${logLabel}):`, e) }
            try { await statusPromise } catch (e) { dbg("CRITIC-SUB", "await status after kill:", e) }
        }

        await Promise.race([drainStdout, new Promise((r) => setTimeout(r, 500))])
        await Promise.race([drainStderr, new Promise((r) => setTimeout(r, 500))])

        const decoder = new TextDecoder()
        const stdoutText = stdoutChunks.map((c) => decoder.decode(c, { stream: false })).join("")
        const stderrText = stderrChunks.map((c) => decoder.decode(c, { stream: false })).join("")
        let parsed = parseCriticStdout(stdoutText)

        // If the critic wrote a substantive response but forgot the
        // format prefix, do a cheap reformat pass instead of wasting
        // the analysis. This avoids re-running commands/heavy analysis.
        if (parsed.verdict === "indecisive" && stdoutText.length > 50) {
            dbg("CRITIC-SUB", `indecisive with ${stdoutText.length}B stdout — trying reformat pass (${logLabel})`)
            const reformatted = await reformatCriticOutput(stdoutText, logLabel)
            if (reformatted) {
                parsed = reformatted
            }
        }

        if (parsed.verdict === "certified") {
            try { Deno.writeTextFileSync(certPath, parsed.body || "(no details)") }
            catch (e) { dbg("CRITIC-SUB", `write cert (${logLabel}):`, e) }
            verdict = "certified"
        } else if (parsed.verdict === "revisions") {
            try { Deno.writeTextFileSync(revPath, parsed.body || "(no details)") }
            catch (e) { dbg("CRITIC-SUB", `write rev (${logLabel}):`, e) }
            verdict = "revisions"
            details = parsed.body || ""
        } else {
            verdict = "indecisive"
            details = stdoutText
                ? `stdout had no 'Accepted:' or 'Revisions:' prefix (${stdoutText.length}B). First 200 chars: ${stdoutText.slice(0, 200)}`
                : "critic wrote nothing to stdout"
        }

        // Flush per-attempt log
        try {
            const header = [
                `# critic_output.log`,
                `# label: ${logLabel}`,
                `# attempt: ${attempt}`,
                `# model: ${model}`,
                `# fallback: ${fallbackModel}`,
                `# spawned: ${new Date(start).toISOString()}`,
                `# verdict: ${verdict}`,
                `# elapsed_ms: ${Date.now() - start}`,
                ``,
                `===== stdout =====`,
                stdoutText || "(empty)",
                ``,
                `===== stderr =====`,
                stderrText || "(empty)",
                ``,
            ].join("\n")
            Deno.writeTextFileSync(logPath, header)
        } catch (e) {
            dbg("CRITIC-SUB", `flush log (${logLabel}):`, e)
        }
    } catch (e) {
        verdict = "error"
        details = String(e)
        dbg("CRITIC-SUB", `runCriticCore threw (${logLabel}):`, e)
    }

    return { verdict, details, elapsedMs: Date.now() - start }
}

/**
 * effect shape: { type: "spawn_critic", taskId, dryRun?, attempt? }
 *                OR { type: "spawn_critic", scheduledRun: { scheduleTaskId, runIso, chatId }, attempt? }
 */
export async function spawnCriticSubprocess(effect, core) {
    if (effect.scheduledRun) {
        return await spawnCriticForScheduledRun(effect, core)
    }
    const { taskId, dryRun = false, attempt = 1 } = effect
    if (!taskId) {
        dbg("CRITIC-SUB", "spawn_critic: missing taskId")
        return
    }

    const found = findTask(core.specialData, taskId)
    if (!found) {
        dbg("CRITIC-SUB", `spawn_critic: task ${taskId} not found`)
        core.enqueueEvent?.({
            type: "critic_verdict",
            taskId,
            chatId: null,
            sessionId: null,
            verdict: "error",
            details: "task not found",
            elapsedMs: 0,
            attempt,
        })
        return
    }

    const { chatId, task } = found
    const sessionId = task.workerSessionId
    const definition = task.definition

    // Terminal states don't get a fresh critic. "escalated" means the
    // previous 3-attempt cycle already gave up and asked the user to
    // intervene; "cancelled" means the user killed it. Running a new
    // critic against either would spam the user with a second
    // escalation message or silently certify a cancelled task.
    if (task.state === "escalated" || task.state === "cancelled") {
        dbg("CRITIC-SUB", `spawn_critic: refusing terminal state=${task.state} for ${taskId}`)
        return
    }

    if (!definition) {
        dbg("CRITIC-SUB", `spawn_critic: no definition for ${taskId}`)
        core.enqueueEvent({
            type: "critic_verdict",
            taskId, chatId, sessionId,
            verdict: "error",
            details: "no definition in state",
            elapsedMs: 0,
            attempt,
        })
        return
    }

    const dir = taskDir(taskId)
    const defPath = join(dir, "definition_of_done.md")

    // Write definition transiently so the critic can read it
    try {
        Deno.writeTextFileSync(defPath, definition)
    } catch (e) {
        dbg("CRITIC-SUB", `spawn_critic: failed to write definition_of_done.md:`, e)
        core.enqueueEvent({
            type: "critic_verdict",
            taskId, chatId, sessionId,
            verdict: "error",
            details: `failed to write definition file: ${e}`,
            elapsedMs: 0,
            attempt,
        })
        return
    }

    if (dryRun) {
        dbg("CRITIC-SUB", `[DRY RUN] would spawn critic for ${taskId}`)
        try {
            Deno.removeSync(defPath)
        } catch (e) {
            dbg("CRITIC-SUB", "dry-run cleanup:", e)
        }
        core.enqueueEvent({
            type: "critic_verdict",
            taskId, chatId, sessionId,
            verdict: "dry-run",
            details: `dry-run for ${taskId}`,
            elapsedMs: 0,
            attempt,
        })
        return
    }

    // Fire the subprocess asynchronously — do NOT await the result
    // inline. When it finishes, enqueue a critic_verdict event.
    //
    // NOTE: do NOT pass --bare. --bare disables OAuth + keychain reads
    // and strictly requires ANTHROPIC_API_KEY. The daemon runs under
    // launchd with no ANTHROPIC_API_KEY, so a --bare subprocess fails
    // with "Not logged in" before getting near the prompt. The user's
    // regular `claude` invocations work via keychain, so the critic
    // should use the same auth path.
    //
    // Model selection: configurable via `cbg config critic_model ...`
    // and `cbg config critic_fallback_model ...`. Defaults to opus
    // primary + sonnet fallback. The critic may need to run tests,
    // review code, and do thorough verification — opus handles this
    // well. Sonnet takes over when opus is overloaded.
    const start = Date.now()
    const prompt = buildCriticPrompt(dir)
    const model = getCriticModel()
    const fallbackModel = getCriticFallbackModel()
    dbg("CRITIC-SUB", `model=${model} fallback=${fallbackModel}`)
    const args = [
        "-p", prompt,
        "--model", model,
        "--fallback-model", fallbackModel,
        "--no-session-persistence",
        "--strict-mcp-config",
        "--add-dir", dir,
        "--dangerously-skip-permissions",
    ]

    dbg("CRITIC-SUB", `spawning critic for ${taskId} (attempt ${attempt})`)

    // Delegate the spawn/watch/parse/log to the shared helper. This is
    // async but we do NOT await — the daemon event loop continues and
    // the critic runs in the background, enqueueing a critic_verdict
    // when done.
    ;(async () => {
        const { verdict, details, elapsedMs } = await runCriticCore({
            dir, attempt, logLabel: `task ${taskId}`,
        })
        // Always clean up the transient definition file the long-task
        // path wrote above (only long-task has this; scheduled-run
        // reuses the locked DoD directly).
        try { Deno.removeSync(defPath) }
        catch (e) { dbg("CRITIC-SUB", "cleanup definition_of_done.md:", e) }

        core.enqueueEvent({
            type: "critic_verdict",
            taskId, chatId, sessionId,
            verdict, details, elapsedMs, attempt,
        })
    })().catch((e) => dbg("CRITIC-SUB", `long-task critic IIFE threw for ${taskId}:`, e))
}

/**
 * Scheduled-run branch of spawnCriticSubprocess. The DoD lives in the
 * parent task dir (locked at definition-submitted time); we copy it
 * into the per-run subdir so runCriticCore's buildCriticPrompt finds
 * it at ./definition_of_done.md the same way long tasks do.
 */
async function spawnCriticForScheduledRun(effect, core) {
    const { scheduledRun, attempt = 1 } = effect
    const { scheduleTaskId, runIso } = scheduledRun
    const runDir = paths.scheduledTaskRunDir(scheduleTaskId, runIso)
    const taskDir = paths.scheduledTaskDir(scheduleTaskId)
    const defSrc = join(taskDir, "definition_of_done.md")
    const defInRun = join(runDir, "definition_of_done.md")

    try {
        const text = Deno.readTextFileSync(defSrc)
        Deno.writeTextFileSync(defInRun, text)
    } catch (e) {
        dbg("CRITIC-SUB", `copy DoD for scheduled run failed:`, e)
        core.enqueueEvent?.({
            type: "critic_verdict",
            scheduledRun,
            verdict: "error",
            details: `failed to read DoD: ${e}`,
            elapsedMs: 0,
            attempt,
        })
        return
    }

    ;(async () => {
        const { verdict, details, elapsedMs } = await runCriticCore({
            dir: runDir, attempt,
            logLabel: `scheduled ${scheduleTaskId} run ${runIso}`,
        })
        core.enqueueEvent?.({
            type: "critic_verdict",
            scheduledRun,
            verdict, details, elapsedMs, attempt,
        })
    })().catch((e) => dbg("CRITIC-SUB", `scheduled critic IIFE threw:`, e))
}
