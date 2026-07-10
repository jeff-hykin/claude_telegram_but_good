// lib/interval-hook-runner.js
//
// Standalone Deno entry point that runs a single interval-hook decision
// function in an ISOLATED subprocess. It is spawned by
// lib/effects/interval-hook-run.js with a hard wall-clock timeout, so a
// buggy or hanging hook can never block the daemon's event loop or crash
// the daemon — the parent just kills this process.
//
// This file is NOT part of the hot-reload graph: it runs in a fresh
// `deno run` and must have no versionedImport / daemon dependencies.
//
// Usage:  deno run --allow-all interval-hook-runner.js <hookFile> <contextFile> <resultFile>
//
// The user's hook.js default-exports a function `(context) => null | string`
// (may be async). Return null to do nothing, or a string to message the
// hook's topic agent. The runner writes a structured result to
// <resultFile> and always exits 0 so the parent reads the result rather
// than guessing from an exit code. Only a timeout (parent kill) or a
// missing result file is treated as a failure by the parent.

const [hookFile, contextFile, resultFile] = Deno.args

async function writeResult(obj) {
    try {
        await Deno.writeTextFile(resultFile, JSON.stringify(obj))
    } catch (error) {
        // Last-ditch: the parent will treat a missing result as a timeout.
        console.error("interval-hook-runner: failed to write result:", error)
    }
}

async function main() {
    let context = {}
    try {
        context = JSON.parse(await Deno.readTextFile(contextFile))
    } catch (error) {
        await writeResult({ status: "error", error: `failed to read context: ${String(error)}` })
        return
    }

    let mod
    try {
        // Cache-bust so an edited hook.js is picked up on the next run
        // even within the same Deno module cache lifetime.
        const url = `${new URL("file://" + hookFile).href}?t=${Date.now()}`
        mod = await import(url)
    } catch (error) {
        await writeResult({ status: "error", error: `failed to import hook: ${error?.stack ?? String(error)}` })
        return
    }

    const fn = mod?.default
    if (typeof fn !== "function") {
        await writeResult({ status: "error", error: "hook.js must default-export a function" })
        return
    }

    let value
    try {
        value = await fn(context)
    } catch (error) {
        await writeResult({ status: "error", error: `hook threw: ${error?.stack ?? String(error)}` })
        return
    }

    if (value === null || value === undefined) {
        await writeResult({ status: "noop" })
        return
    }
    if (typeof value === "string") {
        await writeResult({ status: "message", result: value })
        return
    }
    await writeResult({
        status: "error",
        error: `hook must return null or a string, got ${typeof value}`,
    })
}

await main()
Deno.exit(0)
