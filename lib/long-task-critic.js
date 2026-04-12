/**
 * Critic subprocess spawner for the long-task subsystem.
 *
 * Spawns a hermetic `claude -p` process to independently verify whether
 * a worker's report satisfies the locked definition of done.
 */

import { join } from "../imports.js"
import { dbg } from "./protocol.js"
import { getConfig } from "./config.js"
import { readTask, updateTask, getDefinition, taskPath, appendLog } from "./long-task.js"

// ── Critic prompt ─────────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────

function isoTimestamp() {
    return new Date().toISOString().replace(/:/g, "-").replace(/\./g, "-")
}

function fileExists(path) {
    try {
        Deno.statSync(path)
        return true
    } catch (e) {
        dbg("CRITIC", "fileExists check for", path, ":", e.name)
        return false
    }
}

function getCriticConfig() {
    const lt = getConfig("longTask") || {}
    const critic = lt.critic || {}
    return {
        model: critic.model || "claude-sonnet-4-6",
        fallbackModel: critic.fallbackModel || "claude-haiku-4-5-20251001",
        maxBudget: critic.maxBudgetUsd || "0.50",
        allowedTools: critic.allowedTools || null,
    }
}

// ── Main entry point ──────────────────────────────────────────────

export async function runCritic(taskId, { dryRun = false } = {}) {
    const dir = taskPath(taskId)
    const defMd = getDefinition(taskId)
    const defPath = join(dir, "definition_of_done.md")

    if (!defMd) {
        dbg("CRITIC", "no definition found for task", taskId)
        return { verdict: "error", details: "No definition of done found in memory" }
    }

    try {
        // Write definition transiently so the critic subprocess can read it
        Deno.writeTextFileSync(defPath, defMd)
        dbg("CRITIC", "wrote definition_of_done.md for", taskId)

        if (dryRun) {
            dbg("CRITIC", "dry-run mode — would spawn critic for", taskId)
            return { verdict: "dry-run", details: `Would spawn critic for task ${taskId} in ${dir}` }
        }

        const config = getCriticConfig()
        dbg("CRITIC", "spawning critic for", taskId, "model:", config.model, "budget:", config.maxBudget)

        const args = [
            "-p", CRITIC_PROMPT,
            "--model", config.model,
            "--fallback-model", config.fallbackModel,
            "--bare",
            "--no-session-persistence",
            "--add-dir", dir,
            "--max-budget-usd", String(config.maxBudget),
        ]

        if (config.allowedTools === "*") {
            args.push("--dangerously-skip-permissions")
        } else if (config.allowedTools) {
            args.push("--allowed-tools", config.allowedTools)
        }

        const cmd = new Deno.Command("claude", {
            args,
            stdout: "piped",
            stderr: "piped",
        })

        const proc = cmd.spawn()
        const result = await proc.output()
        const exitCode = result.code
        const stdout = new TextDecoder().decode(result.stdout)
        const stderr = new TextDecoder().decode(result.stderr)

        dbg("CRITIC", "process exited with code", exitCode)
        if (stderr.trim()) {
            dbg("CRITIC", "stderr:", stderr.trim())
        }
        if (stdout.trim()) {
            dbg("CRITIC", "stdout:", stdout.trim().slice(0, 500))
        }

        // Check which files the critic produced
        const hasCert = fileExists(join(dir, "certification.md"))
        const hasRevisions = fileExists(join(dir, "requested_revisions.md"))

        let verdict
        let details

        if (hasCert && hasRevisions) {
            verdict = "anomaly"
            details = "Critic produced both certification.md and requested_revisions.md"
        } else if (hasCert) {
            verdict = "certified"
            details = "Critic certified the task as complete"
        } else if (hasRevisions) {
            // Check for clarification_needed marker
            try {
                const revContent = Deno.readTextFileSync(join(dir, "requested_revisions.md"))
                if (revContent.includes("<!-- clarification_needed -->")) {
                    verdict = "clarification_needed"
                    details = "Critic needs clarification from the user"
                } else {
                    verdict = "revisions"
                    details = "Critic requested revisions"
                }
            } catch (e) {
                dbg("CRITIC", "failed to read requested_revisions.md:", e)
                verdict = "revisions"
                details = "Critic requested revisions (could not read file for clarification check)"
            }
        } else if (exitCode !== 0) {
            verdict = "error"
            details = `Critic process exited with code ${exitCode}: ${stderr.trim().slice(0, 200)}`
        } else {
            verdict = "indecisive"
            details = "Critic produced neither certification.md nor requested_revisions.md"
        }

        dbg("CRITIC", "verdict for", taskId, ":", verdict)

        appendLog(taskId, "critic", {
            verdict,
            details,
            exitCode,
            model: config.model,
        })

        return { verdict, details }
    } catch (e) {
        dbg("CRITIC", "runCritic failed for", taskId, ":", e)
        appendLog(taskId, "critic", {
            verdict: "error",
            details: String(e),
        })
        return { verdict: "error", details: String(e) }
    } finally {
        // ALWAYS clean up the transient definition file
        try {
            Deno.removeSync(defPath)
            dbg("CRITIC", "removed definition_of_done.md for", taskId)
        } catch (e) {
            dbg("CRITIC", "failed to remove definition_of_done.md:", e)
        }
    }
}

// ── Verdict processing ────────────────────────────────────────────

export function processVerdict(taskId, verdict) {
    const dir = taskPath(taskId)

    if (verdict === "certified") {
        updateTask(taskId, { state: "certified" })
        const injectText = "The critic has certified your work as complete. The task is now finished."
        return { state: "certified", injectText, telegramText: null }
    }

    if (verdict === "revisions" || verdict === "anomaly") {
        // Archive requested_revisions.md to revisions/ with timestamp
        const ts = isoTimestamp()
        const revisionsDir = join(dir, "revisions")
        try {
            Deno.mkdirSync(revisionsDir, { recursive: true })
        } catch (e) {
            dbg("CRITIC", "failed to ensure revisions dir:", e)
        }

        const srcPath = join(dir, "requested_revisions.md")
        const archivePath = join(revisionsDir, `requested_revisions_${ts}.md`)
        try {
            const content = Deno.readTextFileSync(srcPath)
            Deno.writeTextFileSync(archivePath, content)
            dbg("CRITIC", "archived requested_revisions.md to", archivePath)
        } catch (e) {
            dbg("CRITIC", "failed to archive requested_revisions.md:", e)
        }

        // Delete report.md so the worker writes a fresh one
        try {
            Deno.removeSync(join(dir, "report.md"))
            dbg("CRITIC", "removed report.md for", taskId)
        } catch (e) {
            dbg("CRITIC", "failed to remove report.md:", e)
        }

        updateTask(taskId, { state: "in_progress" })

        const injectText = [
            "The critic has requested revisions. Review the file at:",
            `  ${archivePath}`,
            "Address all items listed there, then submit a new report when ready.",
        ].join("\n")

        return { state: "in_progress", injectText, telegramText: null }
    }

    if (verdict === "clarification_needed") {
        const srcPath = join(dir, "requested_revisions.md")
        let telegramText = null
        try {
            telegramText = Deno.readTextFileSync(srcPath)
            dbg("CRITIC", "read clarification content for", taskId)
        } catch (e) {
            dbg("CRITIC", "failed to read requested_revisions.md for clarification:", e)
            telegramText = "(Could not read the critic's clarification request.)"
        }

        // Delete the file after reading
        try {
            Deno.removeSync(srcPath)
            dbg("CRITIC", "removed requested_revisions.md after clarification read for", taskId)
        } catch (e) {
            dbg("CRITIC", "failed to remove requested_revisions.md:", e)
        }

        updateTask(taskId, { state: "clarification_needed" })

        return { state: "clarification_needed", injectText: null, telegramText }
    }

    // Other verdicts (indecisive, error, dry-run, etc.)
    dbg("CRITIC", "no processing for verdict:", verdict)
    return { state: null, injectText: null, telegramText: null }
}
