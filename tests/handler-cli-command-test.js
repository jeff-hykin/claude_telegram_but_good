// tests/handler-cli-command-test.js
//
// Unit tests for lib/event-handlers/cli-command.js. Handles kinds:
//   - set_pending_otp
//   - reload_cbg
//   - get_cbg_version
//   - server_dump
//   - shutdown
//   - (unknown)

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, makeCore, fakeConn, effectsOfType, get } from "./_helpers.js"

setupTempPaths("cbg-cli-test-")

const handle = (await import("../lib/event-handlers/cli-command.js")).default

Deno.test("cli-command: set_pending_otp stores otp on chatState and replies closeAfter", () => {
    const core = makeCore()
    const conn = fakeConn("cli")
    const action = handle({
        kind: "set_pending_otp",
        payload: { otp: "XYZ123" },
        _conn: conn,
        ts: 10,
    }, core)
    const stored = get(action, "stateChanges.chatState.pendingOtps.XYZ123")
    assertEquals(stored.createdAt, 10)
    assertEquals(stored.chatId, null)
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc[0].message.ok, true)
    assertEquals(ipc[0].closeAfter, true)
})

Deno.test("cli-command: set_pending_otp without an otp replies with error", () => {
    const core = makeCore()
    const action = handle({
        kind: "set_pending_otp",
        payload: {},
        _conn: fakeConn(),
    }, core)
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc[0].message.ok, false)
})

Deno.test("cli-command: reload_cbg emits bump_cbg_version + reply with projected version", () => {
    const core = makeCore()
    const prev = globalThis.cbgVersion ?? 1
    const action = handle({ kind: "reload_cbg", _conn: fakeConn() }, core)
    const bump = effectsOfType(action, "bump_cbg_version")
    assertEquals(bump.length, 1)
    assertEquals(bump[0].toVersion, prev + 1)
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc[0].message.version, prev + 1)
})

Deno.test("cli-command: get_cbg_version returns the current version", () => {
    const core = makeCore()
    const action = handle({ kind: "get_cbg_version", _conn: fakeConn() }, core)
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc[0].message.ok, true)
    assertEquals(typeof ipc[0].message.version, "number")
})

Deno.test("cli-command: server_dump writes a file and replies with the dump path", () => {
    const core = makeCore({
        chatState: { focusedSessionId: "s1" },
        chatSessions: { "s1": { id: "s1", _conn: fakeConn() } },
        specialData: { longTaskByChatId: {} },
    })
    const action = handle({ kind: "server_dump", payload: {}, _conn: fakeConn() }, core)
    const writes = effectsOfType(action, "write_file")
    assertEquals(writes.length, 1)
    assert(writes[0].path.includes(".cbg-dump.json"))
    const parsed = JSON.parse(writes[0].content)
    assertEquals(parsed.chatState.focusedSessionId, "s1")
    // Underscore-prefixed keys (_conn) must be stripped from the dumped state
    assertEquals("_conn" in parsed.chatSessions.s1, false)
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc[0].message.ok, true)
    assert(typeof ipc[0].message.dumpPath === "string")
})

Deno.test("cli-command: server_dump honors a caller-supplied targetPath", () => {
    const core = makeCore()
    const action = handle({
        kind: "server_dump",
        payload: { targetPath: "/tmp/explicit-dump.json" },
        _conn: fakeConn(),
    }, core)
    const writes = effectsOfType(action, "write_file")
    assertEquals(writes[0].path, "/tmp/explicit-dump.json")
})

Deno.test("cli-command: shutdown replies ok", () => {
    const core = makeCore()
    const action = handle({ kind: "shutdown", _conn: fakeConn() }, core)
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc[0].message.ok, true)
    assertEquals(ipc[0].closeAfter, true)
})

Deno.test("cli-command: unknown kind replies with an error", () => {
    const core = makeCore()
    const action = handle({ kind: "made_up", _conn: fakeConn() }, core)
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc[0].message.ok, false)
    assertEquals(ipc[0].message.error, "unknown kind")
})

Deno.test("cli-command: ask_sync errors when target unresolved", () => {
    const core = makeCore({ chatSessions: {} })
    const conn = fakeConn("ask-cli")
    const action = handle({
        kind: "ask_sync",
        payload: { target: "ghost_session", text: "hi", replyToInbox: "cli1" },
        _conn: conn,
    }, core)
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc.length, 1)
    assertEquals(ipc[0].message.ok, false)
    assertEquals(ipc[0].closeAfter, true)
    assertEquals(effectsOfType(action, "register_inbox_waiter").length, 0)
})

Deno.test("cli-command: ask_sync registers waiter + delivers + no immediate ipc_respond", () => {
    const targetConn = fakeConn("shim")
    const core = makeCore({
        chatSessions: { Target: { id: "Target", _conn: targetConn } },
    })
    const askConn = fakeConn("ask-cli")
    const action = handle({
        kind: "ask_sync",
        payload: { target: "Target", text: "question?", replyToInbox: "cli1" },
        _conn: askConn,
    }, core)
    const reg = effectsOfType(action, "register_inbox_waiter")
    assertEquals(reg.length, 1)
    assertEquals(reg[0].address, "cli1")
    assertEquals(reg[0].targetSessionId, "Target")
    assert(reg[0].conn === askConn)
    const deliver = effectsOfType(action, "deliver_channel_event")
    assertEquals(deliver.length, 1)
    assertEquals(deliver[0].sessionId, "Target")
    assert(deliver[0].content.includes("question?"))
    assertEquals(effectsOfType(action, "ipc_respond").length, 0)
})

Deno.test("cli-command: ask_sync rejects missing fields", () => {
    const core = makeCore()
    for (const bad of [
        { target: "", text: "x", replyToInbox: "c" },
        { target: "x", text: "", replyToInbox: "c" },
        { target: "x", text: "y", replyToInbox: "" },
    ]) {
        const action = handle({ kind: "ask_sync", payload: bad, _conn: fakeConn() }, core)
        const ipc = effectsOfType(action, "ipc_respond")
        assertEquals(ipc[0].message.ok, false)
        assertEquals(ipc[0].closeAfter, true)
    }
})

Deno.test("cli-command: touch_session rejects missing target", () => {
    const core = makeCore()
    const action = handle({ kind: "touch_session", payload: {}, _conn: fakeConn() }, core)
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc[0].message.ok, false)
})

Deno.test("cli-command: touch_session rejects bare/no-prefix targets", () => {
    const core = makeCore()
    const action = handle({ kind: "touch_session", payload: { target: "Foo" }, _conn: fakeConn() }, core)
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc[0].message.ok, false)
    assert(ipc[0].message.error.includes("explicit prefix"))
})

Deno.test("cli-command: touch_session rejects inbox: target", () => {
    const core = makeCore()
    const action = handle({ kind: "touch_session", payload: { target: "inbox:foo" }, _conn: fakeConn() }, core)
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc[0].message.ok, false)
    assert(ipc[0].message.error.includes("inbox"))
})

Deno.test("cli-command: touch_session session: returns existing live session", () => {
    const conn = fakeConn("shim")
    const core = makeCore({
        chatSessions: { Existing: { id: "Existing", title: "old", pid: 1234, dtachSocket: "/tmp/x", _conn: conn } },
    })
    const action = handle({ kind: "touch_session", payload: { target: "session:Existing" }, _conn: fakeConn() }, core)
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc[0].message.ok, true)
    assertEquals(ipc[0].message.info.sessionId, "Existing")
    assertEquals(ipc[0].message.info.created, false)
    assertEquals(ipc[0].message.info.connected, true)
    assertEquals(ipc[0].message.info.pid, 1234)
    // No spawn effect for an existing session
    assertEquals(effectsOfType(action, "spawn_dtach_session").length, 0)
})

Deno.test("cli-command: touch_session session: spawns new session when missing", () => {
    const core = makeCore({ chatSessions: {} })
    const action = handle({ kind: "touch_session", payload: { target: "session:Ghost" }, _conn: fakeConn() }, core)
    const spawn = effectsOfType(action, "spawn_dtach_session")
    assertEquals(spawn.length, 1)
    assertEquals(spawn[0].topicName, null)
    assert(spawn[0].sessionId.length > 0)
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc[0].message.ok, true)
    assertEquals(ipc[0].message.info.created, true)
    assertEquals(ipc[0].message.info.connected, false)
    assertEquals(ipc[0].message.info.topicName, null)
    assertEquals(ipc[0].message.info.sessionId, spawn[0].sessionId)
})

Deno.test("cli-command: touch_session topic: synthesizes threadId when topic unknown to Telegram", () => {
    const core = makeCore({
        chatState: { commandCenter: { topicNames: { "5": "other" }, threadMap: {}, topicMap: {} } },
    })
    const action = handle({ kind: "touch_session", payload: { target: "topic:pr-42" }, _conn: fakeConn() }, core)
    const spawn = effectsOfType(action, "spawn_dtach_session")
    assertEquals(spawn.length, 1)
    assertEquals(spawn[0].title, "pr-42")
    assertEquals(spawn[0].topicName, "pr-42")
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc[0].message.ok, true)
    assertEquals(ipc[0].message.info.topicName, "pr-42")
    assertEquals(ipc[0].message.info.threadId, "synth:pr-42")
    assertEquals(ipc[0].message.info.created, true)
    const patchedThreadMap = get(action, "stateChanges.chatState.commandCenter.threadMap")
    assertEquals(patchedThreadMap["synth:pr-42"], spawn[0].sessionId)
})

Deno.test("cli-command: touch_session topic: idempotent re-touch returns same synth-bound session", () => {
    const targetConn = fakeConn("shim")
    const core = makeCore({
        chatState: { commandCenter: {
            topicNames: { "synth:pr-42": "pr-42" },
            threadMap: { "synth:pr-42": "Synth1" },
            topicMap: { "Synth1": "synth:pr-42" },
        } },
        chatSessions: { Synth1: { id: "Synth1", title: "pr-42", _conn: targetConn } },
    })
    const action = handle({ kind: "touch_session", payload: { target: "topic:pr-42" }, _conn: fakeConn() }, core)
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc[0].message.ok, true)
    assertEquals(ipc[0].message.info.sessionId, "Synth1")
    assertEquals(ipc[0].message.info.threadId, "synth:pr-42")
    assertEquals(ipc[0].message.info.created, false)
    assertEquals(effectsOfType(action, "spawn_dtach_session").length, 0)
})

Deno.test("cli-command: touch_session topic: returns existing session bound to topic", () => {
    const targetConn = fakeConn("shim")
    const core = makeCore({
        chatState: { commandCenter: {
            topicNames: { "19": "cbg" },
            threadMap: { "19": "Bound" },
            topicMap: { "Bound": "19" },
        } },
        chatSessions: { Bound: { id: "Bound", title: "cbg", pid: 99, _conn: targetConn } },
    })
    const action = handle({ kind: "touch_session", payload: { target: "topic:cbg" }, _conn: fakeConn() }, core)
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc[0].message.ok, true)
    assertEquals(ipc[0].message.info.sessionId, "Bound")
    assertEquals(ipc[0].message.info.topicName, "cbg")
    assertEquals(ipc[0].message.info.threadId, "19")
    assertEquals(ipc[0].message.info.created, false)
    assertEquals(effectsOfType(action, "spawn_dtach_session").length, 0)
})

Deno.test("cli-command: touch_session topic: spawns session and binds to topic when missing", () => {
    const core = makeCore({
        chatState: { commandCenter: {
            topicNames: { "19": "cbg" },
            threadMap: {},
            topicMap: {},
        } },
        chatSessions: {},
    })
    const action = handle({ kind: "touch_session", payload: { target: "topic:cbg" }, _conn: fakeConn() }, core)
    const spawn = effectsOfType(action, "spawn_dtach_session")
    assertEquals(spawn.length, 1)
    assertEquals(spawn[0].topicName, "cbg")
    assertEquals(spawn[0].title, "cbg")
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc[0].message.ok, true)
    assertEquals(ipc[0].message.info.topicName, "cbg")
    assertEquals(ipc[0].message.info.threadId, "19")
    assertEquals(ipc[0].message.info.created, true)
    // State patch wires the new session into topicMap/threadMap
    const patchedThreadMap = get(action, "stateChanges.chatState.commandCenter.threadMap")
    assertEquals(patchedThreadMap["19"], spawn[0].sessionId)
    const patchedTopicMap = get(action, "stateChanges.chatState.commandCenter.topicMap")
    assertEquals(patchedTopicMap[spawn[0].sessionId], "19")
})

Deno.test("cli-command: touch_session title: returns unique match", () => {
    const targetConn = fakeConn("shim")
    const core = makeCore({
        chatSessions: {
            S1: { id: "S1", title: "review-helper-pr-42", _conn: targetConn },
            S2: { id: "S2", title: "other", _conn: targetConn },
        },
    })
    const action = handle({ kind: "touch_session", payload: { target: "title:helper" }, _conn: fakeConn() }, core)
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc[0].message.ok, true)
    assertEquals(ipc[0].message.info.sessionId, "S1")
    assertEquals(ipc[0].message.info.created, false)
})

Deno.test("cli-command: touch_session title: errors on ambiguity", () => {
    const targetConn = fakeConn("shim")
    const core = makeCore({
        chatSessions: {
            S1: { id: "S1", title: "review one", _conn: targetConn },
            S2: { id: "S2", title: "review two", _conn: targetConn },
        },
    })
    const action = handle({ kind: "touch_session", payload: { target: "title:review" }, _conn: fakeConn() }, core)
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc[0].message.ok, false)
    assert(ipc[0].message.error.includes("ambiguous"))
})

Deno.test("cli-command: touch_session title: spawns session with given title when no match", () => {
    const core = makeCore({ chatSessions: {} })
    const action = handle({ kind: "touch_session", payload: { target: "title:fresh-title" }, _conn: fakeConn() }, core)
    const spawn = effectsOfType(action, "spawn_dtach_session")
    assertEquals(spawn.length, 1)
    assertEquals(spawn[0].title, "fresh-title")
    assertEquals(spawn[0].topicName, null)
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc[0].message.info.title, "fresh-title")
    assertEquals(ipc[0].message.info.created, true)
})

// ── tell_session --que / ask_sync --que ─────────────────────────────────

Deno.test("cli-command: tell_session --que (busy session) pushes to pendingQueue, no immediate deliver", () => {
    const targetConn = fakeConn("shim")
    const core = makeCore({
        chatSessions: { Target: { id: "Target", _conn: targetConn, status: "working" } },
    })
    const action = handle({
        kind: "tell_session",
        payload: { target: "Target", text: "queued msg", queueUntilIdle: true },
        _conn: fakeConn("cli"),
    }, core)
    // No deliver_channel_event when queued
    assertEquals(effectsOfType(action, "deliver_channel_event").length, 0)
    // Queue entry was added with _source: "cli"
    const patch = get(action, "stateChanges.chatSessions.Target.pendingQueue")
    assertEquals(patch.length, 1)
    assertEquals(patch[0]._source, "cli")
    assert(patch[0].text.includes("queued msg"))
    assert(patch[0].text.includes("[from CLI]"))
    // CLI gets ack ("queued for ...") immediately so it can exit
    const ipc = effectsOfType(action, "ipc_respond")
    assertEquals(ipc.length, 1)
    assertEquals(ipc[0].message.ok, true)
    assert(ipc[0].message.message.includes("queued"))
    assertEquals(ipc[0].closeAfter, true)
})

Deno.test("cli-command: tell_session --que (idle session) delivers immediately (no upcoming Stop to drain on)", () => {
    const targetConn = fakeConn("shim")
    const core = makeCore({
        chatSessions: { Target: { id: "Target", _conn: targetConn, status: "idle" } },
    })
    const action = handle({
        kind: "tell_session",
        payload: { target: "Target", text: "now please", queueUntilIdle: true },
        _conn: fakeConn("cli"),
    }, core)
    const deliver = effectsOfType(action, "deliver_channel_event")
    assertEquals(deliver.length, 1)
    assertEquals(deliver[0].sessionId, "Target")
    // Queue not used
    assertEquals(get(action, "stateChanges.chatSessions.Target.pendingQueue"), undefined)
})

Deno.test("cli-command: tell_session --que appends to existing pendingQueue", () => {
    const targetConn = fakeConn("shim")
    const existing = [{ text: "earlier", chatId: "1", messageId: "m0", queuedAt: 1 }]
    const core = makeCore({
        chatSessions: { Target: { id: "Target", _conn: targetConn, status: "working", pendingQueue: existing } },
    })
    const action = handle({
        kind: "tell_session",
        payload: { target: "Target", text: "later", queueUntilIdle: true },
        _conn: fakeConn("cli"),
    }, core)
    const patch = get(action, "stateChanges.chatSessions.Target.pendingQueue")
    assertEquals(patch.length, 2)
    assertEquals(patch[0].text, "earlier")
    assert(patch[1].text.includes("later"))
})

Deno.test("cli-command: tell_session without --que delivers immediately (regression — busy session)", () => {
    const targetConn = fakeConn("shim")
    const core = makeCore({
        chatSessions: { Target: { id: "Target", _conn: targetConn, status: "working" } },
    })
    const action = handle({
        kind: "tell_session",
        payload: { target: "Target", text: "now" },  // no queueUntilIdle
        _conn: fakeConn("cli"),
    }, core)
    assertEquals(effectsOfType(action, "deliver_channel_event").length, 1)
    assertEquals(get(action, "stateChanges.chatSessions.Target.pendingQueue"), undefined)
})

Deno.test("cli-command: ask_sync --que (busy) registers waiter + queues, no immediate deliver", () => {
    const targetConn = fakeConn("shim")
    const core = makeCore({
        chatSessions: { Target: { id: "Target", _conn: targetConn, status: "working" } },
    })
    const askConn = fakeConn("ask-cli")
    const action = handle({
        kind: "ask_sync",
        payload: { target: "Target", text: "later question", replyToInbox: "cli1", queueUntilIdle: true },
        _conn: askConn,
    }, core)
    // Inbox waiter registered (so we can wake on reply)
    const reg = effectsOfType(action, "register_inbox_waiter")
    assertEquals(reg.length, 1)
    assertEquals(reg[0].address, "cli1")
    // No deliver — it's queued
    assertEquals(effectsOfType(action, "deliver_channel_event").length, 0)
    const patch = get(action, "stateChanges.chatSessions.Target.pendingQueue")
    assertEquals(patch.length, 1)
    assertEquals(patch[0]._source, "cli")
    // No ipc_respond — conn is parked for reply
    assertEquals(effectsOfType(action, "ipc_respond").length, 0)
})

Deno.test("cli-command: --que considers status=idle WITH tool activity since last Stop as busy (CLI-tell heuristic)", () => {
    // chat-user.js sets status="working" on Telegram inbound, but
    // tell_session/ask_sync don't. So a session can be mid-turn with
    // status still showing "idle" — the lastActive>lastStopAt check
    // is what catches that case.
    const targetConn = fakeConn("shim")
    const core = makeCore({
        chatSessions: {
            Target: {
                id: "Target",
                _conn: targetConn,
                status: "idle",       // stale
                lastActive: 5_000,    // pre/post-tool hook bumped this
                lastStopAt: 1_000,    // last Stop was much earlier
            },
        },
    })
    const action = handle({
        kind: "tell_session",
        payload: { target: "Target", text: "queue me", queueUntilIdle: true },
        _conn: fakeConn("cli"),
    }, core)
    // Should treat as busy → queue, not deliver
    assertEquals(effectsOfType(action, "deliver_channel_event").length, 0)
    const patch = get(action, "stateChanges.chatSessions.Target.pendingQueue")
    assertEquals(patch.length, 1)
})

Deno.test("cli-command: --que treats status=idle with lastActive==lastStopAt as truly idle", () => {
    const targetConn = fakeConn("shim")
    const core = makeCore({
        chatSessions: {
            Target: {
                id: "Target",
                _conn: targetConn,
                status: "idle",
                lastActive: 5_000,
                lastStopAt: 5_000,    // Stop just fired
            },
        },
    })
    const action = handle({
        kind: "tell_session",
        payload: { target: "Target", text: "deliver now", queueUntilIdle: true },
        _conn: fakeConn("cli"),
    }, core)
    // Truly idle → deliver immediately
    assertEquals(effectsOfType(action, "deliver_channel_event").length, 1)
    assertEquals(get(action, "stateChanges.chatSessions.Target.pendingQueue"), undefined)
})

Deno.test("cli-command: ask_sync --que (idle) delivers immediately (preserves register-waiter behavior)", () => {
    const targetConn = fakeConn("shim")
    const core = makeCore({
        chatSessions: { Target: { id: "Target", _conn: targetConn, status: "idle" } },
    })
    const action = handle({
        kind: "ask_sync",
        payload: { target: "Target", text: "q?", replyToInbox: "cli1", queueUntilIdle: true },
        _conn: fakeConn("ask-cli"),
    }, core)
    assertEquals(effectsOfType(action, "register_inbox_waiter").length, 1)
    assertEquals(effectsOfType(action, "deliver_channel_event").length, 1)
    assertEquals(get(action, "stateChanges.chatSessions.Target.pendingQueue"), undefined)
})
