// lib/effects/scheduled-task-worker.js
//
// Effects that spawn / inject into / kill the headless scheduled-task
// worker session. The worker is a fresh `claude --no-tele` session
// inside a dtach wrapper. It is NOT registered with CBG's shim
// (invisible to chatSessions and /list). Communication with it is
// entirely through dtach: stdin via `dtach -p`, stdout via the dtach
// log file. When `report.md` appears in the run dir OR the dtach log
// goes idle and the wall-clock budget expires, we hand off to the
// critic via the normal critic-subprocess path.

import { writeFileSync, existsSync, statSync, mkdirSync, readFileSync } from "node:fs"
import { versionedImport } from "../version.js"
import { $, join } from "../../imports.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { paths } = await versionedImport("../paths.js", import.meta)
const { getScheduleWorkerTimeoutMs, getSchedulePermissionArgs } = await versionedImport("../config-manager.js", import.meta)
const { computeIntervalMs } = await versionedImport("../scheduler/index.js", import.meta)

/**
 * Compute the worker budget for a task. Uses the task's rule interval
 * if available (so a 2-hour task gets a 2-hour budget), falling back
 * to the global config default.
 */
function workerBudgetMs(task) {
    const fromRule = task?.rule ? computeIntervalMs(task.rule) : null
    return fromRule ?? getScheduleWorkerTimeoutMs()
}

// Minimum time to wait after spawning before injecting the prompt.
// Claude Code needs time to start up, load plugins, show the TUI, etc.
const STARTUP_WAIT_MS = 20_000
// Additional quiet-check: after the startup wait, we also verify the
// dtach log has been stable for this long.
const LOG_QUIET_MS = 4_000
// Polling cadence for the readiness + report.md watcher.
const READINESS_POLL_MS = 500
// Cap on how long to wait for the prompt banner before giving up and
// injecting anyway.
const READINESS_MAX_MS = 45_000
// How often to poll for report.md during the main watch loop.
const REPORT_POLL_MS = 1_000

function fileLen(path) {
    try { return statSync(path).size }
    catch (e) { dbg("SCHED-WORKER", `statSync ${path}:`, e); return 0 }
}

/**
 * Wait for the session to be ready for input. First waits a fixed
 * STARTUP_WAIT_MS to let Claude Code fully initialize, then verifies
 * the dtach log has content and has been quiet for LOG_QUIET_MS.
 */
async function waitForDtachReady(logFile, maxMs = READINESS_MAX_MS) {
    // Fixed startup delay — Claude Code needs time to boot, load
    // plugins, render the TUI, etc.
    dbg("SCHED-WORKER", `waiting ${STARTUP_WAIT_MS}ms for session startup`)
    await new Promise((r) => setTimeout(r, STARTUP_WAIT_MS))

    const start = Date.now()
    const remainingMs = Math.max(0, maxMs - STARTUP_WAIT_MS)
    let lastSize = 0
    let lastChange = Date.now()
    while (Date.now() - start < remainingMs) {
        const n = fileLen(logFile)
        if (n !== lastSize) {
            lastSize = n
            lastChange = Date.now()
        }
        if (n > 0 && Date.now() - lastChange > LOG_QUIET_MS) {
            return true
        }
        await new Promise((r) => setTimeout(r, READINESS_POLL_MS))
    }
    dbg("SCHED-WORKER", `waitForDtachReady(${logFile}) timed out after ${maxMs}ms`)
    return false
}

async function dtachInject(sockPath, text) {
    try {
        // Send the text content first (without newline).
        await $`dtach -p ${sockPath}`.stdinText(text).timeout(5000)
        // Wait 1s for the TUI to render the input.
        await new Promise((r) => setTimeout(r, 1000))
        // Send \n to submit.
        await $`dtach -p ${sockPath}`.stdinText("\n").timeout(5000)
        // Small delay then send \r as backup.
        await new Promise((r) => setTimeout(r, 500))
        await $`dtach -p ${sockPath}`.stdinText("\r").timeout(5000)
        return true
    } catch (e) {
        dbg("SCHED-WORKER", `dtach -p inject failed for ${sockPath}:`, e)
        return false
    }
}

/**
 * effect shape: {
 *   type: "scheduled_task_worker_spawn",
 *   chatId, scheduleTaskId, runIso,
 * }
 *
 * Pre-creates the run directory, writes instructions.md, then spawns
 * a `claude --no-tele` session inside dtach with cwd=taskDir. Kicks
 * off an async watcher that injects the initial kickoff via dtach,
 * polls for report.md, and enqueues `scheduled_task_worker_report_ready`
 * when it appears. If the budget expires first, enqueues
 * `scheduled_task_run_complete` with status "errored".
 *
 * Returns immediately — the watcher runs in the background.
 */
export async function spawnScheduledTaskWorker(effect, core) {
    const { chatId, scheduleTaskId, runIso } = effect
    if (!chatId || !scheduleTaskId || !runIso) {
        dbg("SCHED-WORKER", "spawn: missing required fields")
        return
    }

    const taskDir = paths.scheduledTaskDir(scheduleTaskId)
    const runDir = paths.scheduledTaskRunDir(scheduleTaskId, runIso)
    const sockPath = paths.scheduledTaskDtachSock(scheduleTaskId, runIso)
    const logFile = paths.scheduledTaskDtachLog(scheduleTaskId, runIso)
    const reportPath = join(runDir, "report.md")
    const instructionsPath = join(runDir, "instructions.md")

    // Pre-create the run dir so the worker can write files immediately.
    try {
        mkdirSync(runDir, { recursive: true })
    } catch (e) {
        dbg("SCHED-WORKER", `mkdir runDir ${runDir}:`, e)
    }

    const task = core.specialData?.scheduledTaskByChatId?.[chatId]?.[scheduleTaskId]
    if (!task) {
        dbg("SCHED-WORKER", `spawn: task ${scheduleTaskId} not in state`)
        core.enqueueEvent?.({
            type: "scheduled_task_run_complete",
            chatId, scheduleTaskId, runIso,
            status: "errored",
            summary: "task missing from state at spawn time",
        })
        return
    }

    const responsePath = join(runDir, "response.md")
    const attachmentsDir = join(runDir, "attachments")

    // Find the most recent completed run's report to give the worker context.
    let previousReport = null
    const runHistory = task.tracking?.runHistory ?? []
    for (let i = runHistory.length - 1; i >= 0; i--) {
        const prev = runHistory[i]
        if (prev.status === "certified" && prev.runIso) {
            const prevReportPath = join(paths.scheduledTaskRunDir(scheduleTaskId, prev.runIso), "report.md")
            try {
                if (existsSync(prevReportPath)) {
                    previousReport = readFileSync(prevReportPath, "utf8").trim()
                    if (previousReport.length > 8000) {
                        previousReport = previousReport.slice(0, 8000) + "\n\n... (truncated)"
                    }
                }
            } catch (e) {
                dbg("SCHED-WORKER", `read previous report failed:`, e)
            }
            break
        }
    }

    const instructions = [
        `# Scheduled task run`,
        ``,
        `Schedule id: ${scheduleTaskId}`,
        `Fire ISO: ${runIso}`,
        `Task dir (your cwd): ${taskDir}`,
        `Run dir (per-fire artifacts): ${runDir}`,
        ``,
        `## Definition of done`,
        ``,
        task.definitionOfDone ?? "(missing — this is a bug, report to user)",
        ``,
        ...(previousReport ? [
            `## Previous run report`,
            ``,
            `The most recent certified run produced this report. Use it for context`,
            `(e.g. what was already checked, what issues were found, what was pushed).`,
            ``,
            previousReport,
            ``,
        ] : []),
        `## Instructions`,
        ``,
        `1. Complete the work described in the definition of done.`,
        `2. Write your output to \`${reportPath}\` — a critic will independently verify it against the definition of done.`,
        `3. Write \`${responsePath}\` with the message you want sent to the user on Telegram.`,
        `   Keep it concise — this text is sent directly as a chat message.`,
        `4. Optionally place files in \`${attachmentsDir}/\` to attach to the Telegram message.`,
        `5. If the critic returns revisions, read \`${join(runDir, "revision_request.md")}\` and update your report.`,
    ].join("\n")

    try {
        writeFileSync(instructionsPath, instructions)
    } catch (e) {
        dbg("SCHED-WORKER", `write instructions failed:`, e)
    }

    // Strip CLAUDE_/MCP_ env vars — same hygiene as commands/new.js
    // and lib/effects/critic-subprocess.js. Prevents the new session
    // from inheriting the daemon's channel/MCP wiring.
    const cleanEnv = { ...Deno.env.toObject() }
    for (const key of Object.keys(cleanEnv)) {
        if (key.startsWith("CLAUDE_") || key.startsWith("MCP_")) {
            delete cleanEnv[key]
        }
    }
    cleanEnv.SHELL = "/bin/bash"

    // Pre-accept the workspace trust dialog for the task dir so claude
    // doesn't block on a "trust this folder" prompt. Best-effort — if
    // ~/.claude.json is missing or malformed, we ignore it and let the
    // normal trust-prompt watcher handle it.
    try {
        const home = Deno.env.get("HOME") ?? ""
        const claudeJsonPath = join(home, ".claude.json")
        const raw = readFileSync(claudeJsonPath, "utf8")
        const claudeJson = JSON.parse(raw)
        if (!claudeJson.projects) { claudeJson.projects = {} }
        if (!claudeJson.projects[taskDir]) { claudeJson.projects[taskDir] = {} }
        claudeJson.projects[taskDir].hasTrustDialogAccepted = true
        writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2))
    } catch (e) {
        dbg("SCHED-WORKER", "pre-accept trust dialog failed (best effort):", e)
    }

    // Spawn `claude --no-tele ...` inside dtach. --no-tele tells the
    // CBG wrapper shim to pass through to the real claude without
    // injecting --channels, so this session has ZERO CBG shim wiring
    // — it never registers with main-server, never appears in /list,
    // never receives channel events. The only way to talk to it is
    // through its dtach sock.
    // --strict-mcp-config prevents the worker from loading MCP servers
    // defined in ~/.claude/settings.json (including CBG's own shim),
    // which would otherwise register as a session and create a Telegram
    // topic. Same fix applied to the critic subprocess (46ddcf7).
    const permArgs = getSchedulePermissionArgs()
    const claudeCmd = permArgs
        ? `claude --no-tele --strict-mcp-config ${permArgs}`
        : `claude --no-tele --strict-mcp-config`
    const inner = `cd "${taskDir}" && ${claudeCmd}`
    const isDarwin = Deno.build.os === "darwin"

    try {
        const cmd = isDarwin
            ? $`dtach -n ${sockPath} -Ez script -q -F ${logFile} bash -c ${inner}`
            : $`dtach -n ${sockPath} -Ez script -fq -c ${inner} ${logFile}`
        await cmd.clearEnv().env(cleanEnv).timeout(5000).stdout("piped").stderr("piped")
    } catch (e) {
        dbg("SCHED-WORKER", `spawn dtach failed for ${scheduleTaskId}:`, e)
        core.enqueueEvent?.({
            type: "scheduled_task_run_complete",
            chatId, scheduleTaskId, runIso,
            status: "errored",
            summary: `spawn failed: ${String(e).slice(0, 200)}`,
        })
        return
    }

    // Watcher coroutine. We do NOT await it — the event handler
    // returns after dtach -n returns and the watcher runs in the
    // background until report.md appears or the budget expires.
    ;(async () => {
        const started = Date.now()
        const budgetMs = workerBudgetMs(task)

        // Wait until claude is at the interactive prompt. If readiness
        // times out, we still try to inject — the alternative is to
        // bail entirely, and we'd rather give the task a chance.
        await waitForDtachReady(logFile)

        const ok = await dtachInject(
            sockPath,
            `Read ./runs/${runIso}/instructions.md and complete the task. The definition of done is in ./definition_of_done.md. When done, write ./runs/${runIso}/report.md.`,
        )
        if (!ok) {
            dbg("SCHED-WORKER", `kickoff inject failed for ${scheduleTaskId}`)
            core.enqueueEvent?.({
                type: "scheduled_task_run_complete",
                chatId, scheduleTaskId, runIso,
                status: "errored",
                summary: "failed to inject kickoff into worker",
            })
            return
        }

        while (Date.now() - started < budgetMs) {
            if (existsSync(reportPath)) {
                dbg("SCHED-WORKER", `report.md appeared for ${scheduleTaskId}; handing off to critic`)
                core.enqueueEvent?.({
                    type: "scheduled_task_worker_report_ready",
                    chatId, scheduleTaskId, runIso,
                })
                return
            }
            await new Promise((r) => setTimeout(r, REPORT_POLL_MS))
        }

        // Budget exhausted — but don't kill the worker. Instead, set
        // skipNext so the next fire doesn't pile on, and warn the user.
        // The worker keeps running and may still finish on its own.
        const mins = Math.round(budgetMs / 60_000)
        dbg("SCHED-WORKER", `worker budget (${mins}m) exhausted for ${scheduleTaskId}; setting skipNext, worker stays alive`)
        core.enqueueEvent?.({
            type: "scheduled_task_worker_overflow",
            chatId, scheduleTaskId, runIso,
            budgetMs,
        })
    })().catch((e) => dbg("SCHED-WORKER", "watcher coroutine threw:", e))
}

/**
 * effect shape: { type: "scheduled_task_worker_inject", scheduleTaskId, runIso, text }
 *
 * Waits for the dtach log to be quiet (so the worker is actually at
 * the prompt — the footgun from commit 53e0c37 "fix nudge"), then
 * injects text via dtach -p. Used for revision feedback after a
 * critic verdict. Also restarts the report-watcher loop so the next
 * `report.md` rewrite re-triggers the critic.
 */
export async function injectScheduledTaskText(effect, core) {
    const { chatId, scheduleTaskId, runIso, text } = effect
    if (!scheduleTaskId || !runIso || !text) { return }
    const sockPath = paths.scheduledTaskDtachSock(scheduleTaskId, runIso)
    const logFile = paths.scheduledTaskDtachLog(scheduleTaskId, runIso)
    const runDir = paths.scheduledTaskRunDir(scheduleTaskId, runIso)
    const reportPath = join(runDir, "report.md")

    ;(async () => {
        await waitForDtachReady(logFile)
        const ok = await dtachInject(sockPath, text)
        if (!ok) {
            dbg("SCHED-WORKER", `inject failed for ${scheduleTaskId} runIso=${runIso}`)
            core.enqueueEvent?.({
                type: "scheduled_task_run_complete",
                chatId, scheduleTaskId, runIso,
                status: "errored",
                summary: "revision inject failed",
            })
            return
        }
        // Re-start the report watcher. The caller (critic-verdict's
        // revisions branch) should have already deleted the old
        // report.md via a `delete_file` effect, so `existsSync`
        // returns false until the worker rewrites it.
        const task = core.specialData?.scheduledTaskByChatId?.[chatId]?.[scheduleTaskId]
        const started = Date.now()
        const budgetMs = workerBudgetMs(task)
        while (Date.now() - started < budgetMs) {
            if (existsSync(reportPath)) {
                core.enqueueEvent?.({
                    type: "scheduled_task_worker_report_ready",
                    chatId, scheduleTaskId, runIso,
                })
                return
            }
            await new Promise((r) => setTimeout(r, REPORT_POLL_MS))
        }
        core.enqueueEvent?.({
            type: "scheduled_task_run_complete",
            chatId, scheduleTaskId, runIso,
            status: "errored",
            summary: `revision watcher exceeded ${budgetMs}ms without new report.md`,
        })
    })().catch((e) => dbg("SCHED-WORKER", "inject watcher threw:", e))
}

/**
 * effect shape: { type: "scheduled_task_worker_kill", scheduleTaskId, runIso }
 *
 * Sends Ctrl+C + exit to gracefully shut down the worker session.
 * Never use SIGINT on the subprocess directly — that would leave
 * dtach holding a dead child. The ^C^C + exit sequence matches the
 * pattern used in commands/kill.js.
 */
export async function killScheduledTaskWorker(effect, _core) {
    const { scheduleTaskId, runIso } = effect
    if (!scheduleTaskId || !runIso) { return }
    const sockPath = paths.scheduledTaskDtachSock(scheduleTaskId, runIso)
    try {
        await $`dtach -p ${sockPath}`.stdinText("\x03\x03\nexit\n").timeout(3000)
    } catch (e) {
        dbg("SCHED-WORKER", `kill inject failed for ${scheduleTaskId}:`, e)
    }
}
