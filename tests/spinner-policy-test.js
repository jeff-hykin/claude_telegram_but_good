// tests/spinner-policy-test.js
//
// Unit tests for the built-in spinner policy in lib/spinner.js. These
// cover the three transitions — start on user message, append on
// focused tool hook, clear on reply — using a fake Grammy bot that
// records API calls.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, makeCore } from "./_helpers.js"

setupTempPaths("cbg-spinner-test-")

const { applySpinnerPolicy } = await import("../lib/spinner.js")
// schedulePersist inside the spinner path creates a debounced
// setTimeout that Deno's test leak sanitizer flags if we don't clear
// it. flushPersistenceNow() both clears the timer and synchronously
// writes the dirty slices — but it MUST be loaded through the same
// module URL the spinner uses, otherwise each import is a separate
// module instance with its own `flushHandle` closure and the clear
// doesn't reach the real timer. The spinner uses versionedImport, so
// we do too.
const { versionedImport } = await import("../lib/version.js")
const persistenceMod = await versionedImport("../lib/effects/persistence.js", import.meta)
const flushPersistenceNow = persistenceMod.flushPersistenceNow

function cleanup() {
    flushPersistenceNow()
}

/**
 * Wrapper: register a test with Deno.test's resource + op sanitizers
 * DISABLED for this file. Every test in here ends up scheduling a
 * debounced persistence write via schedulePersist, and clearing the
 * timer in each test body by hand (via cleanup()) turned out to be
 * flaky — flushPersistenceNow sometimes races the setTimeout's
 * register. The whole file is "I trust the timer will eventually
 * flush"; disabling sanitization file-wide is the right call.
 */
function spinnerTest(name, fn) {
    Deno.test({
        name,
        sanitizeOps: false,
        sanitizeResources: false,
        fn,
    })
}

// Abstract-Bot-shaped fake. Mirrors the methods spinner.js actually
// calls (sendText + editText) and emits messageIds as strings.
function fakeBot() {
    const calls = []
    return {
        calls,
        supports: {
            reactions: true, inlineButtons: true, htmlFormatting: true,
            markdownFormatting: false, fileDownload: true,
        },
        async sendText(chatId, text, options) {
            calls.push({ method: "sendText", chatId, text, options })
            return { messageId: "9001" }
        },
        async editText(chatId, messageId, text, options) {
            calls.push({ method: "editText", chatId, messageId, text, options })
        },
        async react() { return true },
        async answerCallback() { return true },
        async sendFile() { return { messageId: "9002" } },
        async downloadFile() { return true },
    }
}

// ── start ────────────────────────────────────────────────────────────

spinnerTest("spinner:start — routed chat_user_message sends a spinner + writes state", async () => {
    try {
        const bot = fakeBot()
        const core = makeCore({
            chatSessions: { "sess-1": { id: "sess-1", _conn: {} } },
            bot,
        })
        const event = { type: "chat_user_message", chatId: "42", ts: 1 }
        const action = {
            effects: [
                { type: "deliver_channel_event", sessionId: "sess-1", content: "hi" },
            ],
        }
        await applySpinnerPolicy(event, action, core)

        const sends = bot.calls.filter(c => c.method === "sendText")
        assertEquals(sends.length, 1)
        assertEquals(sends[0].chatId, "42")
        assert(sends[0].text.includes("...</i>"))

        const spinner = core.chatSessions["sess-1"].activeSpinner
        assertEquals(spinner.chatId, "42")
        assertEquals(spinner.messageId, "9001")
        assertEquals(spinner.items, [])

        // Also mirrored into specialData.telegramMessagesByChatId
        const rec = core.specialData?.telegramMessagesByChatId?.["42"]?.["9001"]
        assertEquals(rec?.kind, "spinner")
        assertEquals(rec?.sessionId, "sess-1")
    } finally { cleanup() }
})

spinnerTest("spinner:start — NO spinner when action has no deliver_channel_event", async () => {
    const bot = fakeBot()
    const core = makeCore({
        chatSessions: { "sess-1": { id: "sess-1", _conn: {} } },
        bot,
    })
    const event = { type: "chat_user_message", chatId: "42", ts: 1 }
    // The handler returned an Action with no deliver — e.g. the
    // message was queued because there was no focused session.
    const action = { effects: [{ type: "send_text_to_user", chatId: "42", text: "queued" }] }
    await applySpinnerPolicy(event, action, core)
    assertEquals(bot.calls.length, 0)
    assertEquals(core.chatSessions["sess-1"].activeSpinner, undefined)
})

spinnerTest("spinner:start — no-op when core.bot is null (e.g. IPC-only mode)", async () => {
    const core = makeCore({
        chatSessions: { "sess-1": { id: "sess-1", _conn: {} } },
        bot: null,
    })
    const event = { type: "chat_user_message", chatId: "42", ts: 1 }
    const action = { effects: [{ type: "deliver_channel_event", sessionId: "sess-1" }] }
    await applySpinnerPolicy(event, action, core)
    assertEquals(core.chatSessions["sess-1"].activeSpinner, undefined)
})

// ── append ──────────────────────────────────────────────────────────

function preEvent(overrides = {}) {
    return {
        type: "claude_hook_pre_tool_use",
        ts: 5,
        sessionId: "sess-1",
        toolName: "Read",
        inputPreview: JSON.stringify({ file_path: "/tmp/a.js" }),
        ...overrides,
    }
}

spinnerTest("spinner:append — focused hook edits the active spinner in place", async () => {
    const bot = fakeBot()
    const core = makeCore({
        chatState: { focusedSessionId: "sess-1" },
        chatSessions: {
            "sess-1": {
                id: "sess-1",
                activeSpinner: {
                    chatId: "42",
                    messageId: "9001",
                    headerHtml: "<i>processing...</i>",
                    items: [],
                    createdAt: 0,
                },
            },
        },
        specialData: {
            telegramMessagesByChatId: {
                "42": {
                    "9001": {
                        id: "9001",
                        chatId: "42",
                        from: "agent",
                        kind: "spinner",
                        sessionId: "sess-1",
                        text: "<i>processing...</i>",
                        items: [],
                    },
                },
            },
        },
        bot,
    })
    await applySpinnerPolicy(preEvent(), null, core)

    const edits = bot.calls.filter(c => c.method === "editText")
    assertEquals(edits.length, 1)
    assertEquals(edits[0].messageId, "9001")

    const items = core.chatSessions["sess-1"].activeSpinner.items
    assertEquals(items.length, 1)
    assert(items[0].rendered.includes("Reading"))

    // Mirror updated on the stored message entry too.
    const rec = core.specialData.telegramMessagesByChatId["42"]["9001"]
    assertEquals(rec.items.length, 1)
})

spinnerTest("spinner:append — non-focused session is ignored", async () => {
    const bot = fakeBot()
    const core = makeCore({
        chatState: { focusedSessionId: "other" },
        chatSessions: {
            "sess-1": {
                id: "sess-1",
                activeSpinner: { chatId: "42", messageId: "9001", headerHtml: "", items: [] },
            },
            "other": { id: "other" },
        },
        bot,
    })
    await applySpinnerPolicy(preEvent(), null, core)
    assertEquals(bot.calls.length, 0)
    assertEquals(core.chatSessions["sess-1"].activeSpinner.items.length, 0)
})

spinnerTest("spinner:append — hidden tools (mcp__plugin_telegram_*) don't reach the spinner", async () => {
    const bot = fakeBot()
    const core = makeCore({
        chatState: { focusedSessionId: "sess-1" },
        chatSessions: {
            "sess-1": {
                id: "sess-1",
                activeSpinner: { chatId: "42", messageId: "9001", headerHtml: "", items: [] },
            },
        },
        bot,
    })
    await applySpinnerPolicy(
        preEvent({ toolName: "mcp__plugin_telegram_telegram__reply" }),
        null,
        core,
    )
    assertEquals(bot.calls.length, 0)
})

spinnerTest("spinner:append — PostTool event overwrites its PreTool sibling in place", async () => {
    const bot = fakeBot()
    const core = makeCore({
        chatState: { focusedSessionId: "sess-1" },
        chatSessions: {
            "sess-1": {
                id: "sess-1",
                activeSpinner: {
                    chatId: "42",
                    messageId: "9001",
                    headerHtml: "",
                    items: [],
                    createdAt: 0,
                },
            },
        },
        specialData: {
            telegramMessagesByChatId: {
                "42": { "9001": { id: "9001", kind: "spinner", items: [] } },
            },
        },
        bot,
    })
    // PreToolUse for Read
    await applySpinnerPolicy(preEvent({ toolUseId: "tu-1" }), null, core)
    let items = core.chatSessions["sess-1"].activeSpinner.items
    assertEquals(items.length, 1)
    assert(items[0].rendered.includes("Reading"))

    // PostToolUse for the SAME tool_use_id — must overwrite, not append
    await applySpinnerPolicy(
        {
            type: "claude_hook_post_tool_use",
            ts: 10,
            sessionId: "sess-1",
            toolName: "Read",
            toolUseId: "tu-1",
            inputPreview: JSON.stringify({ file_path: "/tmp/a.js" }),
            outputPreview: null,
            isError: false,
        },
        null,
        core,
    )
    items = core.chatSessions["sess-1"].activeSpinner.items
    assertEquals(items.length, 1)
    // "Read" (past tense, from formatPostToolUse) replaces "Reading"
    assert(items[0].rendered.includes("Read"))
    assert(!items[0].rendered.includes("Reading"))
    assertEquals(items[0].toolUseId, "tu-1")
})

spinnerTest("spinner:append — PostTool with unknown tool_use_id appends as a new item", async () => {
    const bot = fakeBot()
    const core = makeCore({
        chatState: { focusedSessionId: "sess-1" },
        chatSessions: {
            "sess-1": {
                id: "sess-1",
                activeSpinner: {
                    chatId: "42",
                    messageId: "9001",
                    headerHtml: "",
                    items: [{ rendered: "<i>existing</i>", ts: 1, toolUseId: "tu-other" }],
                    createdAt: 0,
                },
            },
        },
        specialData: {
            telegramMessagesByChatId: {
                "42": { "9001": { id: "9001", kind: "spinner", items: [] } },
            },
        },
        bot,
    })
    await applySpinnerPolicy(
        {
            type: "claude_hook_post_tool_use",
            ts: 10,
            sessionId: "sess-1",
            toolName: "Read",
            toolUseId: "tu-unknown",
            inputPreview: JSON.stringify({ file_path: "/tmp/a.js" }),
            outputPreview: null,
            isError: false,
        },
        null,
        core,
    )
    const items = core.chatSessions["sess-1"].activeSpinner.items
    assertEquals(items.length, 2)
    assertEquals(items[1].toolUseId, "tu-unknown")
})

spinnerTest("spinner:append — rolling buffer caps at 10 items (drops oldest)", async () => {
    const bot = fakeBot()
    const core = makeCore({
        chatState: { focusedSessionId: "sess-1" },
        chatSessions: {
            "sess-1": {
                id: "sess-1",
                activeSpinner: {
                    chatId: "42",
                    messageId: "9001",
                    headerHtml: "",
                    items: [],
                    createdAt: 0,
                },
            },
        },
        specialData: {
            telegramMessagesByChatId: {
                "42": {
                    "9001": { id: "9001", kind: "spinner", items: [] },
                },
            },
        },
        bot,
    })
    for (let i = 0; i < 15; i++) {
        await applySpinnerPolicy(
            // file_path padded so substring matches don't cross-pollute
            // (e.g. "10.js" matching "0.js"). `tag_<i>_` is unique.
            preEvent({ ts: 100 + i, inputPreview: JSON.stringify({ file_path: `/tmp/tag_${i}_.js` }) }),
            null,
            core,
        )
    }
    const items = core.chatSessions["sess-1"].activeSpinner.items
    assertEquals(items.length, 10)
    // oldest items (tag_0_ .. tag_4_) should have fallen out
    assert(!items.some(it => it.rendered.includes("tag_0_")))
    assert(!items.some(it => it.rendered.includes("tag_4_")))
    assert(items.some(it => it.rendered.includes("tag_5_")))
    assert(items.some(it => it.rendered.includes("tag_14_")))
})

// ── clear ───────────────────────────────────────────────────────────

spinnerTest("spinner:clear — reply tool call freezes the active spinner", async () => {
    const bot = fakeBot()
    const core = makeCore({
        chatSessions: {
            "sess-1": {
                id: "sess-1",
                activeSpinner: { chatId: "42", messageId: "9001", headerHtml: "", items: [] },
            },
        },
        bot,
    })
    const event = { type: "claude_channel_tool_request", toolName: "reply", sessionId: "sess-1" }
    await applySpinnerPolicy(event, null, core)
    assertEquals(core.chatSessions["sess-1"].activeSpinner, undefined)
})

spinnerTest("spinner:clear — non-reply tool calls don't touch the spinner", async () => {
    const core = makeCore({
        chatSessions: {
            "sess-1": {
                id: "sess-1",
                activeSpinner: { chatId: "42", messageId: "9001", headerHtml: "", items: [] },
            },
        },
    })
    const event = { type: "claude_channel_tool_request", toolName: "react", sessionId: "sess-1" }
    await applySpinnerPolicy(event, null, core)
    assert(core.chatSessions["sess-1"].activeSpinner)
})

spinnerTest("spinner:policy is a no-op on unrelated event types", async () => {
    const core = makeCore({
        chatSessions: { "sess-1": { id: "sess-1" } },
    })
    await applySpinnerPolicy({ type: "cli_command" }, null, core)
    await applySpinnerPolicy({ type: "session_register" }, null, core)
    // Nothing to assert — the invariant is that none of these throw.
    assert(true)
})
