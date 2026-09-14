// tests/user-file-delivery-test.js
//
// SendUserFile sends to Claude Code's own "user", which is not the chat
// driving a cbg session — the files vanish and the tool still reports
// success. cbg intercepts the call at PreToolUse, delivers the files
// itself, and denies the tool so nothing reports a phantom success.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, paths, makeCore, effectsOfType } from "./_helpers.js"

const { tempDir: _tempDir } = setupTempPaths("cbg-user-file-test-")

const COMMAND_CENTER = "-100222"
const GROUP = "-100333"

Deno.writeTextFileSync(
    paths.ACCESS_FILE,
    JSON.stringify({
        dmPolicy: "pairing",
        allowFrom: ["42"],
        groups: {},
        botCenterGroups: [],
        groupChats: [GROUP],
        pending: {},
        commandCenterChatId: COMMAND_CENTER,
    }, null, 2),
)

const { planUserFileDelivery, resolveFileTarget } = await import("../lib/user-file-delivery.js")
const preToolUse = (await import("../lib/event-handlers/claude-hook-pre-tool-use.js")).default
const { translateIpcMessage } = await import("../lib/pure/ipc-inbound.js")

const FILES = ["/tmp/report.html", "/tmp/chart.png"]

function topicCore() {
    return makeCore({
        chatState: {
            commandCenter: { topicMap: { "sess-1": "77" }, topicNames: { "77": "Hyperspace" } },
        },
        chatSessions: { "sess-1": { id: "sess-1", _conn: {} } },
    })
}

function sendUserFileEvent(overrides = {}) {
    return {
        type: "claude_hook_pre_tool_use",
        ts: 5000,
        sessionId: "sess-1",
        toolName: "SendUserFile",
        toolInput: { files: FILES, caption: "here you go" },
        _conn: {},
        ...overrides,
    }
}

// ── target resolution ─────────────────────────────────────────────────

Deno.test("resolveFileTarget: a session bound to a topic gets that topic's thread", () => {
    assertEquals(resolveFileTarget("sess-1", topicCore()), { chatId: COMMAND_CENTER, threadId: 77 })
})

Deno.test("resolveFileTarget: a group session gets its group", () => {
    const core = makeCore({
        chatSessions: { "sess-1": { id: "sess-1", listenChatId: GROUP } },
    })
    assertEquals(resolveFileTarget("sess-1", core), { chatId: GROUP, threadId: null })
})

Deno.test("resolveFileTarget: otherwise, the chat that last wrote to it", () => {
    const core = makeCore({
        chatSessions: { "sess-1": { id: "sess-1", lastInbound: { chatId: "555" } } },
    })
    assertEquals(resolveFileTarget("sess-1", core), { chatId: "555", threadId: null })
})

Deno.test("resolveFileTarget: a session with no chat at all resolves to nothing", () => {
    const core = makeCore({ chatSessions: { "sess-1": { id: "sess-1" } } })
    assertEquals(resolveFileTarget("sess-1", core), null)
})

// ── the delivery plan ─────────────────────────────────────────────────

Deno.test("planUserFileDelivery: every file is sent to the session's topic", () => {
    const plan = planUserFileDelivery(sendUserFileEvent(), topicCore())
    assertEquals(plan.effects.length, 2)
    for (const effect of plan.effects) {
        assertEquals(effect.type, "send_file_to_user")
        assertEquals(effect.chatId, COMMAND_CENTER)
        assertEquals(effect.options.message_thread_id, 77)
    }
    // Caption on the first file only — repeating it under each is noise.
    assertEquals(plan.effects[0].caption, "here you go")
    assertEquals(plan.effects[1].caption, undefined)
    assertEquals(plan.effects[0].filename, "report.html")
})

Deno.test("planUserFileDelivery: the deny reason names the files and forbids a resend", () => {
    const plan = planUserFileDelivery(sendUserFileEvent(), topicCore())
    assert(plan.reason.includes("report.html"))
    assert(plan.reason.includes("Do NOT send them again"))
    assert(plan.reason.includes("reply"))
})

Deno.test("planUserFileDelivery: a listening session may not post files into its group", () => {
    const core = makeCore({
        chatSessions: { "sess-1": { id: "sess-1", listenMode: true, listenChatId: GROUP } },
    })
    const plan = planUserFileDelivery(sendUserFileEvent(), core)
    assertEquals(plan.effects.length, 0)
    assert(plan.reason.includes("listen mode"))
})

Deno.test("planUserFileDelivery: an unlocked listening session may send", () => {
    const core = makeCore({
        chatSessions: {
            "sess-1": { id: "sess-1", listenMode: true, listenChatId: GROUP, listenUnlockedAt: 1 },
        },
    })
    const plan = planUserFileDelivery(sendUserFileEvent(), core)
    assertEquals(plan.effects.length, 2)
    assertEquals(plan.effects[0].chatId, GROUP)
})

Deno.test("planUserFileDelivery: no resolvable chat means no send, and says so", () => {
    const core = makeCore({ chatSessions: { "sess-1": { id: "sess-1" } } })
    const plan = planUserFileDelivery(sendUserFileEvent(), core)
    assertEquals(plan.effects.length, 0)
    assert(plan.reason.includes("explicit `chat_id`"))
})

Deno.test("planUserFileDelivery: a call with no files sends nothing", () => {
    const plan = planUserFileDelivery(sendUserFileEvent({ toolInput: { files: [] } }), topicCore())
    assertEquals(plan.effects.length, 0)
})

// ── the hook decision ─────────────────────────────────────────────────

Deno.test("PreToolUse: SendUserFile is denied, and the files go out anyway", () => {
    const action = preToolUse(sendUserFileEvent(), topicCore())
    const responses = effectsOfType(action, "ipc_respond")
    assertEquals(responses.length, 1)
    assertEquals(responses[0].message.deny, true)
    assertEquals(effectsOfType(action, "send_file_to_user").length, 2)
})

Deno.test("PreToolUse: the decision is sent before the uploads", () => {
    // Uploading a 10 MB file outlasts the hook's 3 s read budget; answer
    // late and the hook fails open and Claude sends the file a second time.
    const action = preToolUse(sendUserFileEvent(), topicCore())
    assertEquals(action.effects[0].type, "ipc_respond")
})

Deno.test("PreToolUse: a session cbg does not know is allowed to proceed", () => {
    const action = preToolUse(sendUserFileEvent({ sessionId: "nobody" }), topicCore())
    const responses = effectsOfType(action, "ipc_respond")
    assertEquals(responses.length, 1)
    assertEquals(responses[0].message.deny, false)
    assertEquals(effectsOfType(action, "send_file_to_user").length, 0)
})

// ── the wire ──────────────────────────────────────────────────────────

Deno.test("ipc-inbound: SendUserFile's full input reaches the daemon", () => {
    const [event] = translateIpcMessage({
        type: "hook_event",
        claudePid: 123,
        data: {
            hook_event_name: "PreToolUse",
            tool_name: "SendUserFile",
            tool_input: { files: FILES, caption: "hi" },
        },
    }, {}, makeCore({}))
    assertEquals(event.toolInput.files, FILES)
})

Deno.test("ipc-inbound: another tool's input is still only a preview", () => {
    // A Write's `content` must never ride the IPC wire.
    const [event] = translateIpcMessage({
        type: "hook_event",
        claudePid: 123,
        data: {
            hook_event_name: "PreToolUse",
            tool_name: "Write",
            tool_input: { file_path: "/tmp/x", content: "x".repeat(10000) },
        },
    }, {}, makeCore({}))
    assertEquals(event.toolInput, null)
    // inputPreview is a compacted JSON string, and the content is not in it.
    assertEquals(JSON.parse(event.inputPreview).file_path, "/tmp/x")
    assert(!event.inputPreview.includes("xxxx"))
})
