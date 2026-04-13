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
const CRITIC_PROMPT_PREFIX = `You are the critic for a long-running task. Your job is to independently judge whether the worker's report satisfies the definition of done.

The worker wrote the definition of done before starting work and cannot modify it now. They submitted a report claiming the work is complete. Your job is to verify that claim against the locked definition.

The three key files are embedded below. You do NOT need to Read them again. The task directory is also on --add-dir so you can read progress.md / revisions/ / any other files the report references if needed, and run bash to verify claims (git state, test results, file contents) — trust evidence you gather yourself over the worker's claims.

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

Shirk signals to watch for:
  - "pre-existing failure" / "was already broken"
  - skipped or xfailed tests
  - TODO / FIXME / HACK comments in new code
  - "good enough" / "works for now" / "out of scope"
  - Evidence that references commands not actually run`

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
 * effect shape: { type: "spawn_critic", taskId, dryRun?, attempt? }
 */
export async function spawnCriticSubprocess(effect, core) {
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
    // and `cbg config critic_fallback_model ...`. Defaults to haiku
    // primary + sonnet fallback — haiku is fast, plenty smart for
    // criteria-checking on most tasks, and sonnet automatically takes
    // over when the primary is overloaded. Switching from sonnet-primary
    // dropped typical critic runs from ~60 s to under 20 s on trivial
    // content tasks; swap to sonnet primary if you need stronger
    // judgment for complex code reviews.
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
        "--add-dir", dir,
        "--max-budget-usd", "0.50",
        "--dangerously-skip-permissions",
    ]

    dbg("CRITIC-SUB", `spawning critic for ${taskId} (attempt ${attempt})`)

    // Strip CLAUDE_/MCP_ env vars so the subprocess doesn't inherit the
    // daemon's channel/MCP wiring. Matches the hygiene every other
    // claude-spawning path in this repo uses (new.js, doctor.js).
    const cleanEnv = { ...Deno.env.toObject() }
    for (const key of Object.keys(cleanEnv)) {
        if (key.startsWith("CLAUDE_") || key.startsWith("MCP_")) {
            delete cleanEnv[key]
        }
    }

    // Hard cap: if the subprocess doesn't finish its *visible* work
    // (printing its Accepted:/Revisions: response to stdout) within
    // this budget, we kill it and treat the run as indecisive.
    const HARD_TIMEOUT_MS = 180_000
    // How often to poll while the subprocess runs.
    const POLL_MS = 500
    // Once stdout has content AND hasn't grown for this long, we
    // consider the response complete and kill the subprocess. claude
    // writes its answer to stdout and then (without --bare) spends
    // many minutes on background plugin-sync / skill-prefetch work
    // before exiting — we don't wait.
    const STDOUT_QUIET_MS = 3_000

    const certPath = join(dir, "certification.md")
    const revPath = join(dir, "requested_revisions.md")
    // Per-attempt log so a retried critic run doesn't clobber the
    // evidence from the previous attempt. Helpful when attempt N
    // comes back indecisive/error and you need to see what claude
    // actually wrote vs. what attempt N+1 produced.
    const logPath = join(dir, `critic_output.attempt${attempt}.log`)

    // On attempt 1, remove any stragglers from an even older critic
    // cycle so the directory is clean. Retries keep prior attempt
    // logs in place.
    if (attempt === 1) {
        for (const f of ["critic_output.log"]) {
            try {
                Deno.removeSync(join(dir, f))
            } catch (e) {
                if (!(e instanceof Deno.errors.NotFound)) {
                    dbg("CRITIC-SUB", `remove stale ${f}:`, e)
                }
            }
        }
    }

    ;(async () => {
        let verdict = "error"
        let details = ""
        let child = null
        // Drained asynchronously while the subprocess runs; flushed to
        // critic_output.log after exit/kill so we can see what claude
        // actually did when the result files are missing (indecisive
        // runs). We buffer in memory rather than piping directly to
        // a file because Deno's WritableStream can't be shared between
        // two concurrent pipeTo calls.
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

            // Start draining both streams IMMEDIATELY so a blocked pipe
            // doesn't deadlock the subprocess. Ignore errors (closed
            // stream, kill, etc.) — we'll flush whatever we collected.
            const drainStdout = (async () => {
                try {
                    for await (const chunk of child.stdout) {
                        stdoutChunks.push(chunk)
                    }
                } catch (e) {
                    dbg("CRITIC-SUB", `drain stdout for ${taskId}:`, e)
                }
            })()
            const drainStderr = (async () => {
                try {
                    for await (const chunk of child.stderr) {
                        stderrChunks.push(chunk)
                    }
                } catch (e) {
                    dbg("CRITIC-SUB", `drain stderr for ${taskId}:`, e)
                }
            })()
            // Keep handles reachable so we can await them before flushing.
            child._drainStdout = drainStdout
            child._drainStderr = drainStderr

            // Race: subprocess exit vs. stdout-quiet vs. hard timeout.
            // Stdout "quiet" means we've seen at least one byte AND the
            // total size hasn't changed for STDOUT_QUIET_MS — that's
            // our signal that claude has finished emitting its response
            // and is now sitting on background tasks we don't care about.
            const begin = Date.now()
            let exited = false
            let lastStdoutBytes = 0
            let lastStdoutChangeAt = 0
            const stdoutBytes = () =>
                stdoutChunks.reduce((sum, c) => sum + c.byteLength, 0)

            const statusPromise = child.status.then((s) => {
                exited = true
                return s
            }).catch(() => {
                exited = true
                return null
            })

            while (!exited) {
                if (Date.now() - begin > HARD_TIMEOUT_MS) {
                    dbg("CRITIC-SUB", `hard timeout (${HARD_TIMEOUT_MS}ms) for ${taskId}; will kill`)
                    break
                }
                const n = stdoutBytes()
                if (n !== lastStdoutBytes) {
                    lastStdoutBytes = n
                    lastStdoutChangeAt = Date.now()
                }
                if (n > 0 && lastStdoutChangeAt > 0
                    && Date.now() - lastStdoutChangeAt > STDOUT_QUIET_MS) {
                    dbg("CRITIC-SUB", `stdout stable at ${n}B for ${STDOUT_QUIET_MS}ms for ${taskId}; will kill`)
                    break
                }
                await Promise.race([
                    statusPromise,
                    new Promise((r) => setTimeout(r, POLL_MS)),
                ])
            }

            if (!exited) {
                try {
                    child.kill("SIGKILL")
                } catch (e) {
                    dbg("CRITIC-SUB", `SIGKILL failed for ${taskId}:`, e)
                }
                // Let the process-exit bookkeeping settle, otherwise
                // Deno may complain about leaked resources on daemon
                // shutdown.
                try { await statusPromise } catch (_) { /* ignore */ }
            }

            // Drain any tail that's still buffered in the pipe after
            // exit/kill. Cap at 500ms so we don't block the daemon if
            // the stream is wedged.
            if (child?._drainStdout) {
                await Promise.race([
                    child._drainStdout,
                    new Promise((r) => setTimeout(r, 500)),
                ])
            }
            if (child?._drainStderr) {
                await Promise.race([
                    child._drainStderr,
                    new Promise((r) => setTimeout(r, 500)),
                ])
            }

            // Decode + parse the accumulated stdout and write the
            // result file ourselves (no Write tool call from claude).
            const decoder = new TextDecoder()
            const stdoutText = stdoutChunks
                .map((c) => decoder.decode(c, { stream: false }))
                .join("")
            const parsed = parseCriticStdout(stdoutText)

            if (parsed.verdict === "certified") {
                try {
                    Deno.writeTextFileSync(certPath, parsed.body || "(no details)")
                } catch (e) {
                    dbg("CRITIC-SUB", `write ${certPath}:`, e)
                }
                verdict = "certified"
                details = ""
            } else if (parsed.verdict === "revisions") {
                try {
                    Deno.writeTextFileSync(revPath, parsed.body || "(no details)")
                } catch (e) {
                    dbg("CRITIC-SUB", `write ${revPath}:`, e)
                }
                verdict = "revisions"
                details = ""
            } else {
                verdict = "indecisive"
                details = stdoutText
                    ? `stdout had no 'Accepted:' or 'Revisions:' prefix (${stdoutText.length}B). First 200 chars: ${stdoutText.slice(0, 200)}`
                    : "critic wrote nothing to stdout"
            }
            dbg("CRITIC-SUB", `verdict for ${taskId}: ${verdict} (stdout ${stdoutText.length}B)`)
        } catch (e) {
            verdict = "error"
            details = String(e)
            dbg("CRITIC-SUB", `critic subprocess threw for ${taskId}:`, e)
        } finally {
            // Always clean up the transient definition file
            try {
                Deno.removeSync(defPath)
            } catch (e) {
                dbg("CRITIC-SUB", "cleanup definition_of_done.md:", e)
            }

            // Flush captured stdout+stderr to critic_output.log. Even
            // for certified runs we keep the log around until the next
            // critic attempt — it's the only visibility we have into
            // what claude did, and it's small. The file is deleted at
            // the top of the next critic run (see logPath cleanup above).
            try {
                // If the streams haven't finished draining (e.g. we
                // SIGKILL'd the subprocess mid-stream), give them a
                // brief moment to flush so we don't lose the tail.
                if (child?._drainStdout) {
                    await Promise.race([
                        child._drainStdout,
                        new Promise((r) => setTimeout(r, 500)),
                    ])
                }
                if (child?._drainStderr) {
                    await Promise.race([
                        child._drainStderr,
                        new Promise((r) => setTimeout(r, 500)),
                    ])
                }

                const decoder = new TextDecoder()
                const stdoutText = stdoutChunks
                    .map((c) => decoder.decode(c, { stream: false }))
                    .join("")
                const stderrText = stderrChunks
                    .map((c) => decoder.decode(c, { stream: false }))
                    .join("")

                const header = [
                    `# critic_output.log`,
                    `# taskId: ${taskId}`,
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
                dbg("CRITIC-SUB", `wrote ${logPath} (${stdoutText.length}B stdout, ${stderrText.length}B stderr)`)
            } catch (e) {
                dbg("CRITIC-SUB", "flush critic_output.log:", e)
            }
        }

        const elapsedMs = Date.now() - start
        core.enqueueEvent({
            type: "critic_verdict",
            taskId,
            chatId,
            sessionId,
            verdict,
            details,
            elapsedMs,
            attempt,
        })
    })()
}
