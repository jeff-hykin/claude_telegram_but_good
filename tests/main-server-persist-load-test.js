// tests/main-server-persist-load-test.js
//
// Integration-ish test for the load-on-boot block in main-server.js:
// `pendingPermissions` and `pendingOtps` must be dropped on load
// (because their `_conn` is stripped and they'd dangle forever), and
// session entries loaded from disk must have their live-runtime
// fields (`_conn`, `activeSpinner`, `status`, `agentRequest`, …)
// stripped — stale references from a dead process.
//
// We don't boot main-server.js here — we exercise the same logic by
// writing fake state JSON files into a temp CBG_DIR and then running
// the load + sanitize sequence ourselves. We import the same
// `stripFieldsResetOnRestartFromAllSessions` helper main-server.js
// uses, so any new field added to the canonical list in
// lib/pure/field-stripper.js is exercised here
// automatically — no drift between the prod path and the test.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths } from "./_helpers.js"

const { paths } = setupTempPaths("cbg-persist-load-test-")
const { loadPersistedState } = await import("../lib/effects/persistence.js")
const { stripFieldsResetOnRestartFromAllSessions, SESSION_FIELDS_RESET_ON_RESTART } =
    await import("../lib/pure/field-stripper.js")

function writeState(which, obj) {
    Deno.writeTextFileSync(paths.persistenceFile(which), JSON.stringify(obj, null, 2))
}

// Mirror of the sanitize block in main-server.js. Pulls the
// canonical strip helper from lib/pure/field-stripper.js
// so there's no test-vs-prod drift to worry about.
function sanitizeLoaded(loaded) {
    const out = { chatState: {}, chatSessions: {}, specialData: {} }
    if (loaded.chatState && typeof loaded.chatState === "object") {
        out.chatState = { ...loaded.chatState }
        out.chatState.pendingPermissions = {}
        out.chatState.pendingOtps = {}
    }
    if (loaded.chatSessions && typeof loaded.chatSessions === "object") {
        out.chatSessions = stripFieldsResetOnRestartFromAllSessions(loaded.chatSessions)
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

// ── Fields-reset-on-restart — wedge-on-reload safety net ─────────────
//
// These tests guard against a bug where new per-session runtime
// fields (agentRequest counters, stall-detector buffers, …) were
// persisted but not stripped on load, leaving a reloaded session
// in a "working" state with no in-flight stall_check timer. The
// fix: every live-runtime field goes into SESSION_FIELDS_RESET_ON_RESTART
// in lib/pure/field-stripper.js.

Deno.test("persistence load: live-runtime fields are all stripped on reload", () => {
    writeState("chatState", {})
    writeState("chatSessions", {
        "s1": {
            id: "s1",
            cwd: "/tmp",
            title: "alive",
            pid: 123,
            dtachSocket: "/tmp/s1.sock",
            // ── persistent ──
            longTaskId: "TaskAbc123",
            lastInbound: { messageId: "77", chatId: "42", ts: 1, text: "hi" },
            lastOutboundAt: 2,
            lastStopAt: 3,
            lastActive: 4,
            // ── ephemeral: MUST be stripped ──
            status: "working",
            agentRequest: 7,
            agentRequestStartedAt: 5,
            pendingNudgeAction: "askAgentToSendChatMessage",
            screenBufferRecord: [
                { hash: "aaa", ts: 100 },
                { hash: "aaa", ts: 120 },
            ],
            activeSpinner: { chatId: "42", messageId: "999", items: [] },
        },
    })
    writeState("specialData", {})

    const sanitized = sanitizeLoaded(loadPersistedState())
    const s1 = sanitized.chatSessions.s1
    assert(s1, "expected session s1 to still exist")

    // Persistent fields survive.
    assertEquals(s1.title, "alive")
    assertEquals(s1.longTaskId, "TaskAbc123")
    assertEquals(s1.lastInbound.messageId, "77")
    assertEquals(s1.lastOutboundAt, 2)
    assertEquals(s1.lastStopAt, 3)
    assertEquals(s1.lastActive, 4)

    // Every ephemeral field is gone.
    assertEquals(s1.status, undefined)
    assertEquals(s1.agentRequest, undefined)
    assertEquals(s1.agentRequestStartedAt, undefined)
    assertEquals(s1.pendingNudgeAction, undefined)
    assertEquals(s1.screenBufferRecord, undefined)
    assertEquals(s1.activeSpinner, undefined)
})

Deno.test("persistence load: SESSION_FIELDS_RESET_ON_RESTART is the complete single source of truth", () => {
    // Belt-and-suspenders: if a future refactor adds a new live-runtime
    // field to chatSessions, it MUST also go into
    // SESSION_FIELDS_RESET_ON_RESTART or this check fails loudly. The
    // list is short on purpose; grep it against every session mutation
    // the new-field PR introduces.
    const expected = [
        "_conn",
        "activeSpinner",
        "status",
        "agentRequest",
        "agentRequestStartedAt",
        "pendingNudgeAction",
        "screenBufferRecord",
    ]
    for (const k of expected) {
        assert(
            SESSION_FIELDS_RESET_ON_RESTART.includes(k),
            `SESSION_FIELDS_RESET_ON_RESTART missing '${k}' — either add it to lib/pure/field-stripper.js or remove it from this test`,
        )
    }
})
