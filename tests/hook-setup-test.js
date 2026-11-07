// tests/hook-setup-test.js
//
// installHooks / uninstallHooks against the shapes a real settings.json
// grows over time. The load-bearing case is the pre-rename wrapper
// `<CBG_DIR>/plugin/run/hook`: an install that predates the rename left
// that entry behind, nothing recognised it, and every tool call reported
// a hook failure for as long as it sat there.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, paths } from "./_helpers.js"

setupTempPaths("cbg-hook-setup-test-")

const { installHooks, uninstallHooks, HOOK_EVENTS } = await import("../event-generators/hooks/setup.js")

const LEGACY = `${paths.CBG_DIR}/plugin/run/hook`

/** Every cbg hook command registered for an event. */
function commands(settings, event) {
    return (settings.hooks?.[event] ?? []).flatMap((m) => (m.hooks ?? []).map((h) => h.command))
}

Deno.test("installHooks registers the wrapper once per event", () => {
    const settings = {}
    installHooks(settings)
    installHooks(settings)
    for (const event of HOOK_EVENTS) {
        assertEquals(commands(settings, event), [paths.HOOK_PATH])
    }
})

Deno.test("installHooks rewrites the pre-rename run/hook instead of leaving it", () => {
    const settings = {
        hooks: Object.fromEntries(
            HOOK_EVENTS.map((event) => [event, [{ matcher: "*", hooks: [{ type: "command", command: LEGACY, timeout: 5 }] }]]),
        ),
    }
    installHooks(settings)
    for (const event of HOOK_EVENTS) {
        const cmds = commands(settings, event)
        assert(!cmds.includes(LEGACY), `${event} still points at the path that no longer exists: ${cmds}`)
        assertEquals(cmds, [paths.HOOK_PATH])
    }
})

Deno.test("uninstallHooks removes the pre-rename run/hook too", () => {
    const settings = {
        hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: LEGACY }] }] },
    }
    uninstallHooks(settings)
    assertEquals(commands(settings, "PreToolUse"), [])
})

Deno.test("a user's own run/hook elsewhere is left alone", () => {
    const mine = "/opt/thing/run/hook"
    const settings = {
        hooks: { PreToolUse: [{ matcher: "Skill", hooks: [{ type: "command", command: mine }] }] },
    }
    installHooks(settings)
    assert(commands(settings, "PreToolUse").includes(mine), "clobbered a hook cbg does not own")
    uninstallHooks(settings)
    assertEquals(commands(settings, "PreToolUse"), [mine])
})

Deno.test("installHooks drops a legacy entry that sits beside a current one", () => {
    const settings = {
        hooks: {
            PreToolUse: [
                { matcher: "*", hooks: [{ type: "command", command: LEGACY, timeout: 5, async: true }] },
                { matcher: "*", hooks: [{ type: "command", command: paths.HOOK_PATH, timeout: 5 }] },
            ],
        },
    }
    installHooks(settings)
    assertEquals(commands(settings, "PreToolUse"), [paths.HOOK_PATH])
    assertEquals(settings.hooks.PreToolUse[0].hooks[0].async, undefined)
})
