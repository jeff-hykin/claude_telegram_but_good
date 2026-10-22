// tests/cbg-claude-recursion-test.js
//
// Regression: on Sep 25 2026 a `claude update` racing the shim watcher left
// `_claude_before_cbg` holding the cbg shim itself, so every `claude` exec'd
// `cbg claude` again — ~850 sessions and 29 GB of RAM in half an hour.
// `cbg claude` must refuse a shim backup and exit instead of recursing.

import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts"

const SHIM_MARKER = "# __CBG_SHIM__"
const CLI_JS = new URL("../event-generators/cli/cli.js", import.meta.url).pathname

Deno.test("cbg claude: refuses a _claude_before_cbg that is the shim itself", async () => {
    const root = Deno.makeTempDirSync({ prefix: "cbg-claude-recursion-" })
    const binDir = `${root}/bin`
    Deno.mkdirSync(binDir)
    // Tripwire: if the shim ever runs, this file appears.
    const tripwire = `${root}/shim-ran`
    const shim = `#!/bin/sh\n${SHIM_MARKER}\ntouch "${tripwire}"\n`
    for (const name of ["claude", "_claude_before_cbg"]) {
        Deno.writeTextFileSync(`${binDir}/${name}`, shim)
        Deno.chmodSync(`${binDir}/${name}`, 0o755)
    }

    const output = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", CLI_JS, "claude", "--version"],
        env: {
            PATH: `${binDir}:/usr/bin:/bin`,
            HOME: root,
            CBG_DIR: `${root}/cbg`,
            CLAUDE_DIR: `${root}/claude`,
        },
        clearEnv: true,
        stdout: "piped",
        stderr: "piped",
    }).output()
    const stderr = new TextDecoder().decode(output.stderr)

    assertEquals(output.code, 127, stderr)
    assertStringIncludes(stderr, "is the cbg shim")
    let shimRan = true
    try {
        Deno.statSync(tripwire)
    } catch {
        shimRan = false
    }
    assertEquals(shimRan, false, "cbg claude exec'd the shim backup")
})
