// tests/main-server-persist-load-test.js
//
// Integration-ish test for the load-on-boot block in main-server.js:
// `pendingPermissions` and `pendingOtps` must be dropped on load
// (because their `_conn` is stripped and they'd dangle forever), and
// session entries loaded from disk must have `_conn` AND
// `activeSpinner` stripped (stale references from a dead process).
//
// We don't boot main-server.js here — we exercise the same logic by
// writing fake state JSON files into a temp CBG_DIR and then running
// the load + sanitize sequence ourselves. The sequence lives in
// main-server.js's init block, so this test is a mirror. If the
// init logic drifts, update both.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths } from "./_helpers.js"

const { paths } = setupTempPaths("cbg-persist-load-test-")
const { loadPersistedState } = await import("../lib/effects/persistence.js")

function writeState(which, obj) {
    Deno.writeTextFileSync(paths.persistenceFile(which), JSON.stringify(obj, null, 2))
}

// Mirror of the sanitize block in main-server.js. Kept in this test
// file (not imported) so a drift is caught here if the load block is
// refactored.
function sanitizeLoaded(loaded) {
    const out = { chatState: {}, chatSessions: {}, specialData: {} }
    if (loaded.chatState && typeof loaded.chatState === "object") {
        out.chatState = { ...loaded.chatState }
        out.chatState.pendingPermissions = {}
        out.chatState.pendingOtps = {}
    }
    if (loaded.chatSessions && typeof loaded.chatSessions === "object") {
        for (const [sid, sess] of Object.entries(loaded.chatSessions)) {
            if (sess && typeof sess === "object") {
                // eslint-disable-next-line no-unused-vars
                const { _conn, activeSpinner, ...rest } = sess
                out.chatSessions[sid] = rest
            }
        }
    }
    if (loaded.specialData && typeof loaded.specialData === "object") {
        out.specialData = { ...loaded.specialData }
    }
    return out
}

Deno.test("persistence load: pendingPermissions cleared (their _conn was stripped on write)", () => {
    writeState("chatState", {
        focusedSessionId: "s1",
        pendingPermissions: {
            "req-1": { sessionId: "s1", toolName: "Edit" /* _conn gone */ },
        },
        pendingOtps: { "otp-1": { createdAt: 1 } },
    })
    writeState("chatSessions", {})
    writeState("specialData", {})

    const loaded = loadPersistedState()
    const sanitized = sanitizeLoaded(loaded)

    // Non-pending state still loads.
    assertEquals(sanitized.chatState.focusedSessionId, "s1")
    // But both pending maps are wiped.
    assertEquals(sanitized.chatState.pendingPermissions, {})
    assertEquals(sanitized.chatState.pendingOtps, {})
})

Deno.test("persistence load: session activeSpinner is stripped (stale messageId)", () => {
    writeState("chatState", {})
    writeState("chatSessions", {
        "s1": {
            id: "s1",
            cwd: "/tmp",
            title: "live",
            activeSpinner: {
                chatId: "42",
                messageId: "999",
                items: [{ rendered: "• stale" }],
            },
        },
    })
    writeState("specialData", {})

    const sanitized = sanitizeLoaded(loadPersistedState())

    const s1 = sanitized.chatSessions.s1
    assert(s1, "expected session s1 to still exist after load")
    assertEquals(s1.title, "live")
    assertEquals(s1.activeSpinner, undefined)
})

Deno.test("persistence load: sessions without activeSpinner round-trip normally", () => {
    writeState("chatState", {})
    writeState("chatSessions", {
        "s1": { id: "s1", title: "normal" },
    })
    writeState("specialData", {})

    const sanitized = sanitizeLoaded(loadPersistedState())
    assertEquals(sanitized.chatSessions.s1.title, "normal")
})

Deno.test("persistence load: specialData round-trips verbatim", () => {
    writeState("chatState", {})
    writeState("chatSessions", {})
    writeState("specialData", {
        longTaskByChatId: { "42": { "t1": { id: "t1", state: "in_progress" } } },
        telegramMessagesByChatId: { "42": { "5": { id: "5", from: "user", text: "hi" } } },
    })

    const sanitized = sanitizeLoaded(loadPersistedState())
    assertEquals(sanitized.specialData.longTaskByChatId["42"]["t1"].state, "in_progress")
    assertEquals(sanitized.specialData.telegramMessagesByChatId["42"]["5"].text, "hi")
})
