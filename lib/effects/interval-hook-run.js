// lib/effects/interval-hook-run.js
//
// Runs one interval-hook decision function in an isolated, killable
// `deno run` subprocess and enqueues `interval_hook_run_complete` with
// the structured outcome. The subprocess (lib/interval-hook-runner.js)
// is spawned inside a background coroutine that we do NOT await — mirror
// of lib/effects/scheduled-task-worker.js — so a slow/hanging hook can
// never block the event loop. If the wall-clock budget expires, dax
// kills the child and we report status "timeout".

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs"
import { versionedImport } from "../version.js"
import { $, join } from "../../imports.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { paths } = await versionedImport("../paths.js", import.meta)

// Default per-run budget. A decision function should be fast (poll a
// file, hit an API, do a quick check). Hooks can override via
// config.timeoutMs, passed through on the effect.
const DEFAULT_HOOK_TIMEOUT_MS = 30_000

const runnerPath = new URL("../interval-hook-runner.js", import.meta.url).pathname

/**
 * effect shape: {
 *   type: "interval_hook_run",
 *   chatId, hookId, runIso, timeoutMs?,
 * }
 */
export async function runIntervalHook(effect, core) {
    const { chatId, hookId, runIso } = effect
    if (!chatId || !hookId || !runIso) {
        dbg("IHOOK-RUN", "run: missing required fields")
        return
    }

    const hook = core.specialData?.intervalHookByChatId?.[chatId]?.[hookId]
    if (!hook) {
        dbg("IHOOK-RUN", `run: hook ${hookId} not in state`)
        core.enqueueEvent?.({
            type: "interval_hook_run_complete",
            chatId, hookId, runIso,
            status: "error",
            error: "hook missing from state at run time",
        })
        return
    }

    const hookFile = paths.intervalHookFile(hookId)
    const stateDir = paths.intervalHookStateDir(hookId)
    const runDir = paths.intervalHookRunDir(hookId, runIso)
    const contextFile = join(runDir, "context.json")
    const resultFile = join(runDir, "result.json")

    try { mkdirSync(runDir, { recursive: true }) } catch (e) { dbg("IHOOK-RUN", `mkdir runDir:`, e) }
    try { mkdirSync(stateDir, { recursive: true }) } catch (e) { dbg("IHOOK-RUN", `mkdir stateDir:`, e) }

    const context = {
        hookId,
        topic: hook.topic,
        title: hook.title,
        chatId,
        now: new Date().toISOString(),
        fireIso: runIso,
        totalRuns: hook.tracking?.totalRuns ?? 0,
        lastRunAt: hook.tracking?.lastRunAt ?? null,
        lastRunStatus: hook.tracking?.lastRunStatus ?? null,
        lastResult: hook.tracking?.lastResult ?? null,
        stateDir,
    }

    try {
        writeFileSync(contextFile, JSON.stringify(context, null, 2))
    } catch (e) {
        dbg("IHOOK-RUN", `write context failed:`, e)
        core.enqueueEvent?.({
            type: "interval_hook_run_complete",
            chatId, hookId, runIso,
            status: "error",
            error: `failed to write context: ${String(e).slice(0, 200)}`,
        })
        return
    }

    const budgetMs = Number(effect.timeoutMs) > 0 ? Number(effect.timeoutMs) : DEFAULT_HOOK_TIMEOUT_MS

    // Strip CLAUDE_/MCP_ env so the subprocess never inherits the
    // daemon's channel/MCP wiring. Same hygiene as scheduled-task-worker.
    const cleanEnv = { ...Deno.env.toObject() }
    for (const key of Object.keys(cleanEnv)) {
        if (key.startsWith("CLAUDE_") || key.startsWith("MCP_")) {
            delete cleanEnv[key]
        }
    }

    // Background coroutine — NOT awaited. The effect returns immediately;
    // the run completes asynchronously and enqueues its own follow-up.
    ;(async () => {
        try {
            await $`deno run --allow-all ${runnerPath} ${hookFile} ${contextFile} ${resultFile}`
                .clearEnv()
                .env(cleanEnv)
                .timeout(budgetMs)
                .stdout("piped")
                .stderr("piped")
        } catch (e) {
            // Timeout (dax kills the child) or spawn failure. Distinguish
            // by whether the runner managed to write a result first.
            if (!existsSync(resultFile)) {
                const secs = Math.round(budgetMs / 1000)
                dbg("IHOOK-RUN", `hook ${hookId} timed out/failed after ${secs}s:`, e)
                core.enqueueEvent?.({
                    type: "interval_hook_run_complete",
                    chatId, hookId, runIso,
                    status: "timeout",
                    error: `hook did not finish within ${secs}s (killed)`,
                })
                return
            }
            // Runner wrote a result before a non-zero exit — fall through
            // to read it below.
            dbg("IHOOK-RUN", `hook ${hookId} subprocess errored but wrote result:`, e)
        }

        let parsed = null
        try {
            parsed = JSON.parse(readFileSync(resultFile, "utf8"))
        } catch (e) {
            dbg("IHOOK-RUN", `read result failed for ${hookId}:`, e)
            core.enqueueEvent?.({
                type: "interval_hook_run_complete",
                chatId, hookId, runIso,
                status: "error",
                error: `could not read hook result: ${String(e).slice(0, 200)}`,
            })
            return
        }

        core.enqueueEvent?.({
            type: "interval_hook_run_complete",
            chatId, hookId, runIso,
            status: parsed.status ?? "error",
            result: parsed.result ?? null,
            error: parsed.error ?? null,
        })
    })().catch((e) => dbg("IHOOK-RUN", "run coroutine threw:", e))
}
