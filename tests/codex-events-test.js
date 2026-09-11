// Tests for lib/pure/codex-events.js — the layer that decides what the
// Telegram spinner says and which sentence the user actually receives.
// Every fixture below is a trimmed copy of real `codex app-server`
// traffic (codex-cli 0.149.1), so a protocol change breaks a test here
// rather than a live session.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"
import {
    hookViewForItem,
    toolResponsePreview,
    agentTextFromTurn,
    usageFromTokenUsage,
    describeItem,
} from "../lib/pure/codex-events.js"

Deno.test("hookViewForItem: conversation items produce no spinner", () => {
    for (const type of ["userMessage", "agentMessage", "reasoning", "contextCompaction"]) {
        assertEquals(hookViewForItem({ type, id: "x" }), null)
    }
    assertEquals(hookViewForItem(null), null)
    assertEquals(hookViewForItem({}), null)
})

Deno.test("hookViewForItem: commandExecution becomes Bash", () => {
    const view = hookViewForItem({
        type: "commandExecution",
        id: "exec-1",
        command: "/bin/zsh -lc 'echo hello-from-codex'",
    })
    assertEquals(view, { toolName: "Bash", toolInput: { command: "/bin/zsh -lc 'echo hello-from-codex'" } })
})

Deno.test("hookViewForItem: fileChange picks Write for adds, Edit otherwise", () => {
    const added = hookViewForItem({
        type: "fileChange",
        changes: [{ path: "/tmp/new.js", kind: { type: "add" } }],
    })
    assertEquals(added, { toolName: "Write", toolInput: { file_path: "/tmp/new.js" } })

    const edited = hookViewForItem({
        type: "fileChange",
        changes: [{ path: "/tmp/old.js", kind: { type: "update" } }],
    })
    assertEquals(edited.toolName, "Edit")
})

Deno.test("hookViewForItem: a multi-file patch names one path and counts the rest", () => {
    const view = hookViewForItem({
        type: "fileChange",
        changes: [
            { path: "/tmp/a.js", kind: { type: "update" } },
            { path: "/tmp/b.js", kind: { type: "update" } },
            { path: "/tmp/c.js", kind: { type: "update" } },
        ],
    })
    assertEquals(view.toolInput.file_path, "/tmp/a.js (+2 more)")
})

Deno.test("hookViewForItem: mcpToolCall keeps the mcp__server__tool shape", () => {
    const view = hookViewForItem({
        type: "mcpToolCall",
        server: "probe",
        tool: "probe_magic_number",
        arguments: { a: 1 },
    })
    assertEquals(view, { toolName: "mcp__probe__probe_magic_number", toolInput: { a: 1 } })
})

Deno.test("hookViewForItem: an unknown item type still spins under its own name", () => {
    assertEquals(hookViewForItem({ type: "somethingNew", id: "n" }), {
        toolName: "somethingNew",
        toolInput: {},
    })
})

Deno.test("toolResponsePreview: exit 0 is stdout, nonzero is an error", () => {
    assertEquals(
        toolResponsePreview({ type: "commandExecution", status: "completed", exitCode: 0, aggregatedOutput: "hello\n" }),
        { stdout: "hello\n" },
    )
    assertEquals(
        toolResponsePreview({ type: "commandExecution", status: "failed", exitCode: 2, aggregatedOutput: "boom" }),
        { error: "exit 2: boom" },
    )
})

Deno.test("toolResponsePreview: output is capped so the daemon cannot cut it mid-JSON", () => {
    const preview = toolResponsePreview({
        type: "commandExecution",
        status: "completed",
        exitCode: 0,
        aggregatedOutput: "x".repeat(5000),
    })
    assertEquals(preview.stdout.length, 150)
})

Deno.test("toolResponsePreview: fileChange summarizes the paths it touched", () => {
    assertEquals(
        toolResponsePreview({
            type: "fileChange",
            status: "completed",
            changes: [{ path: "/tmp/a.js", kind: { type: "update" } }, { path: "/tmp/b.js", kind: { type: "add" } }],
        }),
        { output: "update /tmp/a.js, add /tmp/b.js" },
    )
})

Deno.test("agentTextFromTurn: commentary is never the reply", () => {
    // The real failure this guards: delivering "I'll take a look" to the
    // user and silently dropping the answer that came after it.
    const turn = {
        items: [
            { type: "agentMessage", phase: "commentary", text: "I'll take a look at that file." },
            { type: "commandExecution", command: "cat x" },
            { type: "agentMessage", phase: "final_answer", text: "It prints `hello`." },
        ],
    }
    assertEquals(agentTextFromTurn(turn), "It prints `hello`.")
})

Deno.test("agentTextFromTurn: unlabelled messages fall back to the last one", () => {
    const turn = {
        items: [
            { type: "agentMessage", text: "first" },
            { type: "agentMessage", text: "second" },
        ],
    }
    assertEquals(agentTextFromTurn(turn), "second")
})

Deno.test("agentTextFromTurn: an interrupted turn carries no items", () => {
    assertEquals(agentTextFromTurn({ status: "interrupted", items: [], itemsView: "notLoaded" }), "")
    assertEquals(agentTextFromTurn(null), "")
})

Deno.test("usageFromTokenUsage: the window is the LAST request, not the running total", () => {
    // `total` is a cumulative bill across the whole thread — using it
    // would climb past the context limit and stay pinned there.
    const usage = usageFromTokenUsage({
        total: { inputTokens: 900_000, outputTokens: 50_000 },
        last: { totalTokens: 11665, inputTokens: 11589, cachedInputTokens: 0, outputTokens: 76 },
        modelContextWindow: 258400,
    })
    assertEquals(usage.tokens, 11665)
    assertEquals(usage.limit, 258400)
    assertEquals(usage.percentUsed, 5)
})

Deno.test("usageFromTokenUsage: no reported window means no percentage", () => {
    const usage = usageFromTokenUsage({ last: { inputTokens: 10, outputTokens: 5 } })
    assertEquals(usage, { tokens: 15, limit: null, percentUsed: null })
})

Deno.test("describeItem: one transcript line per item type", () => {
    assertEquals(describeItem({ type: "agentMessage", text: "hi" }), "[assistant] hi")
    assertEquals(describeItem({ type: "commandExecution", command: "ls", exitCode: 0 }), "[bash] ls (exit 0)")
    assertEquals(describeItem({ type: "mcpToolCall", server: "s", tool: "t" }), "[mcp] s/t")
    assertEquals(describeItem({ type: "webSearch", query: "deno" }), "[search] deno")
    assertEquals(describeItem({ type: "mystery" }), "[mystery]")
})
