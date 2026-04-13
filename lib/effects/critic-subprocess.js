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

const CRITIC_PROMPT = `You are the critic for a long-running task. Your job is to independently judge whether the worker's report satisfies the definition of done. You have file access to this task's directory.

The worker wrote the definition of done before starting work and cannot modify it now. They submitted a report claiming the work is complete. Your job is to verify that claim against the locked definition.

Read these files:
  - definition_of_done.md — the locked definition of done
  - context.md — the worker's description of the starting state
  - report.md — the worker's claim of completion with evidence
  - progress.md — the worker's notes (may be incomplete)
  - revisions/ — any prior revision requests and outcomes

You have tool access to verify claims in the report. Run commands if the report cites test results, git state, or file contents — trust evidence you gather yourself over the worker's claims.

Do your best with the definition you have, even if it's vague. A vague definition still means something — use your judgment.

You MUST produce EXACTLY ONE of these files:
  - certification.md — if the done condition is clearly and fully satisfied. Include a checklist mapping each criterion to concrete evidence you verified.
  - requested_revisions.md — if anything is unclear, incomplete, shortcuts were taken, or evidence is weak. List concrete items the worker must address. Be specific about what's missing.

Shirk signals to watch for:
  - "pre-existing failure" / "was already broken"
  - skipped or xfailed tests
  - TODO / FIXME / HACK comments in new code
  - "good enough" / "works for now" / "out of scope"
  - Evidence that references commands not actually run

Do not produce both files. Do not produce neither.`

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
    const start = Date.now()
    const args = [
        "-p", CRITIC_PROMPT,
        "--model", "claude-sonnet-4-6",
        "--fallback-model", "claude-haiku-4-5-20251001",
        "--bare",
        "--no-session-persistence",
        "--add-dir", dir,
        "--max-budget-usd", "0.50",
        "--dangerously-skip-permissions",
    ]

    dbg("CRITIC-SUB", `spawning critic for ${taskId} (attempt ${attempt})`)

    ;(async () => {
        let verdict = "error"
        let details = ""
        try {
            const proc = new Deno.Command("claude", {
                args,
                stdout: "piped",
                stderr: "piped",
            })
            const output = await proc.output()
            const stdout = new TextDecoder().decode(output.stdout)
            const stderr = new TextDecoder().decode(output.stderr)

            if (!output.success) {
                verdict = "error"
                details = stderr.slice(0, 1000) || `exit code ${output.code}`
                dbg("CRITIC-SUB", `critic failed for ${taskId}:`, details)
            } else {
                const hasCert = fileExists(join(dir, "certification.md"))
                const hasRev = fileExists(join(dir, "requested_revisions.md"))
                if (hasCert && hasRev) {
                    verdict = "anomaly"
                    details = "critic produced both certification and requested_revisions"
                } else if (hasCert) {
                    verdict = "certified"
                    details = stdout.slice(0, 500)
                } else if (hasRev) {
                    const revContent = Deno.readTextFileSync(join(dir, "requested_revisions.md"))
                    if (revContent.includes("<!-- clarification_needed -->")) {
                        verdict = "clarification_needed"
                    } else {
                        verdict = "revisions"
                    }
                    details = stdout.slice(0, 500)
                } else {
                    verdict = "indecisive"
                    details = "critic produced neither file"
                }
                dbg("CRITIC-SUB", `verdict for ${taskId}: ${verdict}`)
            }
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
