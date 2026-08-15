// tests/agent-backend-test.js — the agent-backend interface contract.
//
// Guards the two things a broken backend would break silently: the shape
// every implementation must satisfy, and the registry's fallback to
// Claude for unknown/absent backend names (which is what keeps every
// pre-existing session working after this refactor).

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"

const { defineBackend, validateBackend, NO_CAPABILITIES } = await import("../lib/agent-backends/spec.js")

Deno.test("defineBackend requires a name", () => {
    let threw = false
    try {
        defineBackend({})
    } catch {
        threw = true
    }
    assert(threw, "defineBackend should throw without a name")
})

Deno.test("defineBackend fills every method with an unsupported stub", async () => {
    const backend = defineBackend({ name: "stub" })
    assertEquals(validateBackend(backend), [])
    const result = await backend.spawn({ sessionId: "X" })
    assertEquals(result.ok, false)
    assert(result.detail.includes("stub"), "detail should name the backend")
})

Deno.test("defineBackend defaults every capability to false", () => {
    const backend = defineBackend({ name: "stub", capabilities: { screen: true } })
    assertEquals(backend.capabilities.screen, true)
    for (const flag of Object.keys(NO_CAPABILITIES)) {
        if (flag === "screen") { continue }
        assertEquals(backend.capabilities[flag], false, `${flag} should default to false`)
    }
})

Deno.test("validateBackend reports missing methods and flags", () => {
    const problems = validateBackend({ name: "bad", capabilities: {} })
    assert(problems.some((p) => p.includes("spawn")), "should flag missing spawn")
    assert(problems.some((p) => p.includes("rawInput")), "should flag missing capability")
    assertEquals(validateBackend(null), ["not an object"])
})

Deno.test("both shipped backends satisfy the interface", async () => {
    const claude = (await import("../lib/agent-backends/claude.js")).backend
    const local = (await import("../lib/agent-backends/local-openai.js")).backend
    assertEquals(validateBackend(claude), [])
    assertEquals(validateBackend(local), [])
    assertEquals(claude.name, "claude")
    assertEquals(local.name, "local")
})

Deno.test("registry falls back to claude for unknown and legacy sessions", async () => {
    const { getBackend, backendForSession, DEFAULT_BACKEND_NAME } = await import("../lib/agent-backends/index.js")
    assertEquals(DEFAULT_BACKEND_NAME, "claude")
    assertEquals(getBackend("no-such-backend").name, "claude")
    // Every shim in the wild predates the `backend` field.
    assertEquals(backendForSession({ id: "Legacy" }).name, "claude")
    assertEquals(backendForSession({ id: "New", backend: "local" }).name, "local")
})

Deno.test("a TUI-less backend degrades rather than throwing", async () => {
    const local = (await import("../lib/agent-backends/local-openai.js")).backend
    const result = await local.sendRawInput({ session: { id: "X" }, text: "hi" })
    assertEquals(result.ok, false)
    assert(result.detail.includes("local"), "detail should name the backend")
})
