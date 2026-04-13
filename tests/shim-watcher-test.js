// tests/shim-watcher-test.js
//
// Integration tests for the live shim file watcher at
// lib/effects/shim-watcher.js. These use a real Deno.watchFs handle on
// a real temp directory — no mocking — because the thing under test is
// precisely the filesystem-event plumbing, and a mock would prove
// nothing.
//
// Each test:
//   1. makes a temp directory and writes a fake "claude" script that
//      contains the SHIM_MARKER plus a sibling `_claude_before_cbg`.
//   2. starts the watcher with overridePath pointing at the fake shim.
//   3. mutates the fake shim to simulate a clobber (or leaves it alone
//      to exercise the noop path).
//   4. polls up to ~1 s for the expected outcome, then stops the watcher.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"

const { startShimWatcher } = await import("../lib/effects/shim-watcher.js")

const SHIM_MARKER = "# __CBG_SHIM__"

function makeFakeShimDir(prefix) {
    const dir = Deno.makeTempDirSync({ prefix })
    const claudePath = `${dir}/claude`
    const backupPath = `${dir}/_claude_before_cbg`
    // The "real claude binary" — any content works, it just needs to
    // exist so inspectShimPath() doesn't return null.
    Deno.writeTextFileSync(backupPath, "#!/bin/sh\necho real-claude\n")
    Deno.chmodSync(backupPath, 0o755)
    return { dir, claudePath, backupPath }
}

function installedShim() {
    return `#!/usr/bin/env sh\n${SHIM_MARKER}\nexec cbg claude "$@"\n`
}

async function waitFor(predicate, timeoutMs = 1500, stepMs = 25) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (predicate()) { return true }
        await new Promise(r => setTimeout(r, stepMs))
    }
    return predicate()
}

Deno.test("shim-watcher: reinstalls shim when it gets clobbered", async () => {
    const { claudePath } = makeFakeShimDir("cbg-shim-watch-clobber-")
    // Start with an intact shim so the watcher's initial findClaudeBinary
    // is not needed — we're using overridePath.
    Deno.writeTextFileSync(claudePath, installedShim())
    Deno.chmodSync(claudePath, 0o755)

    const handle = startShimWatcher(null, { overridePath: claudePath })
    assert(handle.enabled, "watcher should have started")

    try {
        // Let the watcher loop actually open the watch handle before
        // we start stomping on the file, otherwise we can race the
        // for-await initialization and miss the event entirely.
        await new Promise(r => setTimeout(r, 150))

        // Clobber: replace the shim with a file that does NOT contain
        // the marker. Simulates npm/Claude Code auto-update rewriting
        // the wrapper.
        Deno.writeTextFileSync(claudePath, "#!/bin/sh\necho clobbered\n")

        // Within the debounce window (~200 ms) + a little slack, the
        // watcher should have noticed the clobber and rewritten the
        // shim (installShim puts the SHIM_MARKER back).
        const healed = await waitFor(() => {
            try {
                const content = Deno.readTextFileSync(claudePath)
                return content.includes(SHIM_MARKER)
            } catch {
                return false
            }
        }, 2000)
        assert(healed, "watcher did not reinstall the shim within 2s")
    } finally {
        handle.stop()
    }
})

Deno.test("shim-watcher: does NOT rewrite when the shim is already intact", async () => {
    const { claudePath } = makeFakeShimDir("cbg-shim-watch-noop-")
    Deno.writeTextFileSync(claudePath, installedShim())
    Deno.chmodSync(claudePath, 0o755)

    const originalContent = Deno.readTextFileSync(claudePath)
    const originalMtime = Deno.statSync(claudePath).mtime?.getTime() ?? 0

    const handle = startShimWatcher(null, { overridePath: claudePath })
    assert(handle.enabled, "watcher should have started")

    try {
        await new Promise(r => setTimeout(r, 150))

        // Touch the file WITHOUT clobbering — same content + valid
        // marker — so the watcher fires a modify event and runs
        // checkAndHeal(), which should take the "shim still intact"
        // branch and NOT rewrite.
        Deno.writeTextFileSync(claudePath, originalContent)

        // Give the watcher a full debounce window plus slack to react.
        await new Promise(r => setTimeout(r, 500))

        const finalContent = Deno.readTextFileSync(claudePath)
        assertEquals(finalContent, originalContent, "watcher should have left an intact shim alone")
    } finally {
        handle.stop()
    }
})
