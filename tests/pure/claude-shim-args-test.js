// tests/pure/claude-shim-args-test.js
//
// Unit tests for the pure shim argv parser that backs `cbg claude`.
// This module has no side effects — so we can just import it statically
// and exercise every branch.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"

const { parseClaudeShimArgs } = await import("../../lib/pure/claude-shim-args.js")

// ── --no-tele escape hatch ─────────────────────────────────────────

Deno.test("parseClaudeShimArgs: --no-tele strips first arg", () => {
    const r = parseClaudeShimArgs(["--no-tele", "foo", "bar"], {})
    assertEquals(r.mode, "notele")
    assertEquals(r.userArgs, ["foo", "bar"])
    assertEquals(r.injectArgs, [])
})

Deno.test("parseClaudeShimArgs: --no-tele with no trailing args", () => {
    const r = parseClaudeShimArgs(["--no-tele"], {})
    assertEquals(r.mode, "notele")
    assertEquals(r.userArgs, [])
})

Deno.test("parseClaudeShimArgs: --no-tele mid-args does NOT trigger notele mode", () => {
    // Only the FIRST arg position triggers --no-tele. Mid-args gets
    // passthrough-flag-checked instead (and --no-tele isn't in the
    // passthrough set), so we fall through to interactive.
    const r = parseClaudeShimArgs(["foo", "--no-tele"], { permArgs: "" })
    assertEquals(r.mode, "interactive")
})

// ── passthrough subcommands ────────────────────────────────────────

for (const sub of ["agents", "auth", "auto-mode", "doctor", "install", "mcp", "plugin", "plugins", "setup-token", "update", "upgrade"]) {
    Deno.test(`parseClaudeShimArgs: subcommand "${sub}" is passthrough`, () => {
        const r = parseClaudeShimArgs([sub, "list"], {})
        assertEquals(r.mode, "passthrough")
        assertEquals(r.userArgs, [sub, "list"])
        assertEquals(r.injectArgs, [])
    })
}

// ── passthrough flags ──────────────────────────────────────────────

for (const flag of ["-p", "--print", "-v", "--version", "-h", "--help"]) {
    Deno.test(`parseClaudeShimArgs: flag "${flag}" anywhere triggers passthrough`, () => {
        const r = parseClaudeShimArgs(["some", "stuff", flag, "more"], {})
        assertEquals(r.mode, "passthrough")
    })
}

// ── interactive mode / injection ───────────────────────────────────

Deno.test("parseClaudeShimArgs: empty args -> interactive with channels injected", () => {
    const r = parseClaudeShimArgs([], { permArgs: "" })
    assertEquals(r.mode, "interactive")
    assertEquals(r.injectArgs, ["--channels", "plugin:telegram@claude-plugins-official"])
    assertEquals(r.userArgs, [])
})

Deno.test("parseClaudeShimArgs: interactive with permArgs expands them", () => {
    const r = parseClaudeShimArgs([], { permArgs: "--permission-mode all" })
    assertEquals(r.mode, "interactive")
    assertEquals(r.injectArgs, [
        "--channels", "plugin:telegram@claude-plugins-official",
        "--permission-mode", "all",
    ])
})

Deno.test("parseClaudeShimArgs: interactive with existing --channels suppresses injection", () => {
    const r = parseClaudeShimArgs(["--channels", "foo"], { permArgs: "--permission-mode all" })
    assertEquals(r.mode, "interactive")
    // No --channels injected (user already supplied), but permArgs still injected
    assertEquals(r.injectArgs, ["--permission-mode", "all"])
    assertEquals(r.userArgs, ["--channels", "foo"])
})

Deno.test("parseClaudeShimArgs: interactive with --permission-mode already present suppresses permArgs", () => {
    const r = parseClaudeShimArgs(["--permission-mode", "plan"], { permArgs: "--permission-mode all" })
    assertEquals(r.mode, "interactive")
    // User's --permission-mode stays in userArgs; we don't double-inject
    assertEquals(r.injectArgs, ["--channels", "plugin:telegram@claude-plugins-official"])
})

Deno.test("parseClaudeShimArgs: --dangerously-skip-permissions also suppresses permArgs", () => {
    const r = parseClaudeShimArgs(["--dangerously-skip-permissions"], { permArgs: "--permission-mode all" })
    assertEquals(r.mode, "interactive")
    assertEquals(r.injectArgs, ["--channels", "plugin:telegram@claude-plugins-official"])
})

Deno.test("parseClaudeShimArgs: args with spaces in values pass through unchanged", () => {
    // argv is an array, so spaces in individual tokens are preserved
    // automatically — this just asserts we don't mangle them.
    const r = parseClaudeShimArgs(["--initial-prompt", "hello world"], { permArgs: "" })
    assertEquals(r.mode, "interactive")
    assertEquals(r.userArgs, ["--initial-prompt", "hello world"])
})

Deno.test("parseClaudeShimArgs: whitespace-only permArgs is treated as empty", () => {
    const r = parseClaudeShimArgs([], { permArgs: "   \n  " })
    assertEquals(r.injectArgs, ["--channels", "plugin:telegram@claude-plugins-official"])
})

Deno.test("parseClaudeShimArgs: missing opts object defaults permArgs to empty", () => {
    const r = parseClaudeShimArgs([])
    assertEquals(r.mode, "interactive")
    assertEquals(r.injectArgs, ["--channels", "plugin:telegram@claude-plugins-official"])
})

Deno.test("parseClaudeShimArgs: null/undefined args treated as empty", () => {
    const r = parseClaudeShimArgs(null, {})
    assertEquals(r.mode, "interactive")
    assertEquals(r.userArgs, [])
})
