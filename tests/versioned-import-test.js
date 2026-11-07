// tests/versioned-import-test.js
//
// Concurrent versionedImport of a module still in top-level await. Deno
// >=2.7 panics ("RefCell already borrowed") on a second import() of such
// a URL, which killed every hook, CLI and shim process on startup. The
// panic takes the whole process down, so the fixture runs in a child.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"

Deno.test("versionedImport survives concurrent imports of a TLA module", async () => {
    const main = new URL("./fixtures/tla-concurrent-import/main.js", import.meta.url)
    const out = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", main.href],
        stdout: "piped",
        stderr: "piped",
    }).output()
    const stderr = new TextDecoder().decode(out.stderr)
    assertEquals(out.code, 0, stderr)
    assertEquals(new TextDecoder().decode(out.stdout).trim(), "ok")
})
