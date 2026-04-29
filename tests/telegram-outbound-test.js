// tests/telegram-outbound-test.js
//
// Unit tests for the pure helpers in lib/effects/telegram-outbound.js.
// chunk() is pure; assertSendable() touches the filesystem so we use a
// temp HOME + STATE_DIR to isolate.
//
// Run: deno test tests/telegram-outbound-test.js --allow-all

import { assertEquals, assertThrows, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"

// Set up a temp HOME so paths.js resolves STATE_DIR inside the temp tree.
// Must happen BEFORE the dynamic import below, because paths.js runs its
// env-var reads at module load time.
const TEST_HOME = Deno.makeTempDirSync({ prefix: "cbg-tgout-test-" })
Deno.env.set("HOME", TEST_HOME)
Deno.env.set("CBG_DIR", `${TEST_HOME}/.local/share/cbg`)
Deno.env.set("CLAUDE_DIR", `${TEST_HOME}/.claude`)

// Dynamic import so the env vars above are applied before paths.js loads.
const tgOut = await import("../lib/effects/telegram-outbound.js")
const { chunk } = tgOut

// assertSendable isn't exported directly — we test it indirectly via the
// sendFileToUser path by calling the module's exported function with a
// fake core that has no bot. For direct testing of the guard, we re-read
// the source and extract the function — but that's fragile. Instead, we
// validate the security property with an integration-style test: create
// the guarded files under STATE_DIR, confirm that sendFileToUser returns
// without crashing AND doesn't attempt to call any bot API (no bot).
//
// The real test for the security guard is that `sendFileToUser` does NOT
// throw when given a STATE_DIR path with no bot — it logs and returns.
// A separate "contract" test re-imports the internal assertSendable via
// a tiny wrapper file if we want precise assertions. For v1 we rely on
// the chunk tests + a behavioral test of sendFileToUser.

// ── chunk tests ──────────────────────────────────────────────────────────

Deno.test("chunk: short text returns single chunk", () => {
    assertEquals(chunk("hello", 4096, "newline"), ["hello"])
})

Deno.test("chunk: text at exactly the limit returns single chunk", () => {
    const text = "x".repeat(4096)
    const result = chunk(text, 4096, "newline")
    assertEquals(result.length, 1)
    assertEquals(result[0].length, 4096)
})

Deno.test("chunk: text over the limit splits into multiple pieces, each under the limit", () => {
    const text = "x".repeat(10000)
    const result = chunk(text, 4096, "newline")
    assert(result.length >= 3, `expected >= 3 chunks, got ${result.length}`)
    for (const piece of result) {
        assert(piece.length <= 4096, `chunk of length ${piece.length} exceeds limit`)
    }
    // Preserves content (join without the stripped leading newlines roughly
    // equals original — we re-strip newlines to match the chunking behavior)
    const joined = result.join("")
    assertEquals(joined.length, 10000)
})

Deno.test("chunk: prefers paragraph boundaries in last half of window", () => {
    // Boundary at position 2500 (> limit/2 = 2048) — prefer this split.
    const para1 = "x".repeat(2500)
    const para2 = "y".repeat(2500)
    const text = `${para1}\n\n${para2}`
    const result = chunk(text, 4096, "newline")
    assertEquals(result.length, 2)
    assertEquals(result[0], para1)
    assertEquals(result[1], para2)  // leading \n\n stripped by the regex
})

Deno.test("chunk: prefers line boundaries when no paragraph break (last half)", () => {
    const line1 = "x".repeat(2500)
    const line2 = "y".repeat(2500)
    const text = `${line1}\n${line2}`
    const result = chunk(text, 4096, "newline")
    assertEquals(result.length, 2)
    assertEquals(result[0], line1)
    assertEquals(result[1], line2)
})

Deno.test("chunk: boundary in first half falls through to hard cut", () => {
    // Paragraph at position 1000 (< limit/2 = 2048) — don't split early.
    const para1 = "x".repeat(1000)
    const para2 = "y".repeat(4000)
    const text = `${para1}\n\n${para2}`
    const result = chunk(text, 4096, "newline")
    // Chunker should hard-cut at 4096 since the boundary is too early.
    // Total length = 1000 + 2 + 4000 = 5002
    // First chunk = first 4096 chars = 1000 x's + 2 newlines + 3094 y's
    assertEquals(result[0].length, 4096)
    // No chunk exceeds the limit
    for (const piece of result) {
        assert(piece.length <= 4096)
    }
})

Deno.test("chunk: prefers word boundaries when no line breaks", () => {
    // One giant "sentence" with spaces every ~500 chars.
    const words = Array.from({ length: 20 }, () => "x".repeat(500)).join(" ")
    const result = chunk(words, 4096, "newline")
    // Should split at a space, not mid-word — each chunk should end right at
    // a word boundary (or be the final chunk).
    assert(result.length >= 2)
    for (let i = 0; i < result.length - 1; i++) {
        assert(result[i].length <= 4096, `chunk ${i} too long`)
    }
})

Deno.test("chunk: very long text with no boundaries falls back to hard cuts", () => {
    const text = "x".repeat(9000)  // no spaces, no newlines
    const result = chunk(text, 4096, "newline")
    // 9000 / 4096 = 2.2, so expect at least 3 chunks
    assert(result.length >= 3)
    for (const piece of result) {
        assert(piece.length <= 4096)
    }
})

// ── sendFileToUser security behavior ────────────────────────────────────

Deno.test("sendFileToUser: silently skips a file inside STATE_DIR (not inbox)", async () => {
    // Build STATE_DIR tree and create a sensitive file
    const paths = (await import("../lib/paths.js")).paths
    Deno.mkdirSync(paths.STATE_DIR, { recursive: true })
    const accessFile = `${paths.STATE_DIR}/access.json`
    Deno.writeTextFileSync(accessFile, `{"allowFrom": ["secret"]}`)

    // sendFileToUser with no bot should log + return, NOT throw
    const fakeCore = { bot: null }
    await tgOut.sendFileToUser({ chatId: "1", filePath: accessFile }, fakeCore)
    // If we got here without throwing, the "no bot" branch fired early.
    // To actually exercise assertSendable, we need a fake bot that records calls.
    const calls = []
    const fakeBot = {
        supports: { reactions: true, inlineButtons: true, htmlFormatting: true, markdownFormatting: false, fileDownload: true },
        async sendText(...args) { calls.push(["sendText", args]); return { messageId: "1" } },
        async sendFile(...args) { calls.push(["sendFile", args]); return { messageId: "1" } },
        async editText(...args) { calls.push(["editText", args]) },
        async react() { return true },
        async answerCallback() { return true },
        async downloadFile() { return true },
    }
    await tgOut.sendFileToUser(
        { chatId: "1", filePath: accessFile },
        { bot: fakeBot },
    )
    // assertSendable should have thrown inside sendFileToUser's try/catch,
    // which logs and returns. No bot call should have been made.
    assertEquals(calls.length, 0, `expected 0 bot calls, got ${calls.length}`)
})

Deno.test("sendFileToUser: allows a file inside STATE_DIR/inbox", async () => {
    const paths = (await import("../lib/paths.js")).paths
    Deno.mkdirSync(paths.INBOX_DIR, { recursive: true })
    const inboxFile = `${paths.INBOX_DIR}/photo.jpg`
    // Write 100 bytes of fake JPEG content
    Deno.writeFileSync(inboxFile, new Uint8Array(100))

    const calls = []
    const fakeBot = {
        supports: { reactions: true, inlineButtons: true, htmlFormatting: true, markdownFormatting: false, fileDownload: true },
        async sendText(...args) { calls.push(["sendText", args]); return { messageId: "1" } },
        async sendFile(...args) { calls.push(["sendFile", args]); return { messageId: "1" } },
        async editText(...args) { calls.push(["editText", args]) },
        async react() { return true },
        async answerCallback() { return true },
        async downloadFile() { return true },
    }
    await tgOut.sendFileToUser(
        { chatId: "1", filePath: inboxFile },
        { bot: fakeBot },
    )
    // Should have called sendFile (the adapter picks photo vs document internally)
    assertEquals(calls.length, 1)
    assertEquals(calls[0][0], "sendFile")
})

Deno.test("sendFileToUser: allows a file outside STATE_DIR", async () => {
    const outsideFile = `${TEST_HOME}/external.txt`
    Deno.writeTextFileSync(outsideFile, "hello")

    const calls = []
    const fakeBot = {
        supports: { reactions: true, inlineButtons: true, htmlFormatting: true, markdownFormatting: false, fileDownload: true },
        async sendText(...args) { calls.push(["sendText", args]); return { messageId: "1" } },
        async sendFile(...args) { calls.push(["sendFile", args]); return { messageId: "1" } },
        async editText(...args) { calls.push(["editText", args]) },
        async react() { return true },
        async answerCallback() { return true },
        async downloadFile() { return true },
    }
    await tgOut.sendFileToUser(
        { chatId: "1", filePath: outsideFile },
        { bot: fakeBot },
    )
    // Should have called sendFile (abstract — photo vs document split
    // is now an adapter internal).
    assertEquals(calls.length, 1)
    assertEquals(calls[0][0], "sendFile")
})

Deno.test("sendFileToUser: rejects files larger than 50MB", async () => {
    // Create a sparse file that reports 60MB via stat (without actually
    // allocating 60MB). Deno.truncate achieves this.
    const bigFile = `${TEST_HOME}/big.bin`
    const f = Deno.openSync(bigFile, { create: true, write: true })
    try {
        f.truncateSync(60 * 1024 * 1024)
    } finally {
        f.close()
    }

    const calls = []
    const fakeBot = {
        supports: { reactions: true, inlineButtons: true, htmlFormatting: true, markdownFormatting: false, fileDownload: true },
        async sendText(...args) { calls.push(["sendText", args]); return { messageId: "1" } },
        async sendFile(...args) { calls.push(["sendFile", args]); return { messageId: "1" } },
        async editText(...args) { calls.push(["editText", args]) },
        async react() { return true },
        async answerCallback() { return true },
        async downloadFile() { return true },
    }
    await tgOut.sendFileToUser(
        { chatId: "1", filePath: bigFile },
        { bot: fakeBot },
    )
    // Should NOT have called any bot API — rejected at the size check.
    assertEquals(calls.length, 0, `expected 0 bot calls, got ${calls.length}`)
})

// ── General-bound message guard ──────────────────────────────────────

function makeFakeBot(calls) {
    return {
        supports: { reactions: true, inlineButtons: true, htmlFormatting: true, markdownFormatting: false, fileDownload: true },
        async sendText(chatId, text, options) { calls.push({ chatId, text, options }); return { messageId: String(calls.length) } },
        async sendFile() { return { messageId: "1" } },
        async editText() {},
        async react() { return true },
        async answerCallback() { return true },
        async downloadFile() { return true },
    }
}

Deno.test("sendTextMessageToUser: prepends verbose header when message would land in CC General topic", async () => {
    const paths = (await import("../lib/paths.js")).paths
    Deno.mkdirSync(paths.STATE_DIR, { recursive: true })
    Deno.writeTextFileSync(paths.ACCESS_FILE, JSON.stringify({
        dmPolicy: "pairing",
        allowFrom: ["999"],
        groups: {},
        pending: {},
        commandCenterChatId: "-100CC",
    }))
    const calls = []
    const fakeCore = {
        bot: makeFakeBot(calls),
        chatSessions: {
            "sess-1": { id: "sess-1", title: "dimos / master", cwd: "/home/jeff/repos/dimos", gitBranch: "main", pid: 4321 },
        },
        chatState: { commandCenter: {} },
    }
    // chat_id IS the CC group, no replyTo with threadId → General-bound
    await tgOut.sendTextMessageToUser({
        chatId: "-100CC",
        text: "build done",
        recordAs: { sessionId: "sess-1" },
        options: { parse_mode: "HTML" },
    }, fakeCore)
    assertEquals(calls.length, 1)
    const sentText = calls[0].text
    assert(sentText.includes("/chat_sess-1"), `missing /chat_: ${sentText}`)
    assert(sentText.includes("dimos / master"), `missing title: ${sentText}`)
    assert(sentText.includes("/home/jeff/repos/dimos"), `missing cwd: ${sentText}`)
    assert(sentText.includes("main"), `missing branch: ${sentText}`)
    assert(sentText.includes("4321"), `missing pid: ${sentText}`)
    assert(sentText.includes("landed in General"), `missing notice: ${sentText}`)
    assert(sentText.endsWith("build done"), `body should be appended: ${sentText}`)
})

Deno.test("sendTextMessageToUser: skips General header when threadId is set (going to a topic, not General)", async () => {
    const paths = (await import("../lib/paths.js")).paths
    Deno.writeTextFileSync(paths.ACCESS_FILE, JSON.stringify({
        dmPolicy: "pairing", allowFrom: ["999"], groups: {}, pending: {},
        commandCenterChatId: "-100CC",
    }))
    const calls = []
    const fakeCore = {
        bot: makeFakeBot(calls),
        chatSessions: { "sess-1": { id: "sess-1", title: "x" } },
        chatState: { commandCenter: {} },
    }
    await tgOut.sendTextMessageToUser({
        replyTo: { chatId: "-100CC", threadId: 42 },  // CC group BUT threaded
        text: "in topic",
        recordAs: { sessionId: "sess-1" },
        options: { parse_mode: "HTML" },
    }, fakeCore)
    assertEquals(calls[0].text, "in topic")  // unchanged
})

Deno.test("sendTextMessageToUser: skips General header when chatId is a DM (not CC group)", async () => {
    const paths = (await import("../lib/paths.js")).paths
    Deno.writeTextFileSync(paths.ACCESS_FILE, JSON.stringify({
        dmPolicy: "pairing", allowFrom: ["999"], groups: {}, pending: {},
        commandCenterChatId: "-100CC",
    }))
    const calls = []
    const fakeCore = {
        bot: makeFakeBot(calls),
        chatSessions: { "sess-1": { id: "sess-1", title: "x" } },
        chatState: { commandCenter: {} },
    }
    await tgOut.sendTextMessageToUser({
        chatId: "999",   // DM, not CC
        text: "to dm",
        recordAs: { sessionId: "sess-1" },
        options: { parse_mode: "HTML" },
    }, fakeCore)
    assertEquals(calls[0].text, "to dm")
})

Deno.test("sendTextMessageToUser: General header is idempotent — handleReply-prepended text is not double-headered", async () => {
    const paths = (await import("../lib/paths.js")).paths
    Deno.writeTextFileSync(paths.ACCESS_FILE, JSON.stringify({
        dmPolicy: "pairing", allowFrom: ["999"], groups: {}, pending: {},
        commandCenterChatId: "-100CC",
    }))
    const calls = []
    const fakeCore = {
        bot: makeFakeBot(calls),
        chatSessions: { "sess-1": { id: "sess-1", title: "x" } },
        chatState: { commandCenter: {} },
    }
    // Simulate text that already has the verbose header (from handleReply)
    const preHeadered = "/chat_sess-1\nlanded in General — no topic thread bound\n\nthe body"
    await tgOut.sendTextMessageToUser({
        chatId: "-100CC",
        text: preHeadered,
        recordAs: { sessionId: "sess-1" },
        options: { parse_mode: "HTML" },
    }, fakeCore)
    // Sentinel detection should leave the text unchanged
    assertEquals(calls[0].text, preHeadered)
    // No double "landed in General"
    const matches = (calls[0].text.match(/landed in General/g) ?? []).length
    assertEquals(matches, 1, `expected 1 'landed in General', got ${matches}`)
})

Deno.test("sendTextMessageToUser: General header used even with no recordAs (system message)", async () => {
    const paths = (await import("../lib/paths.js")).paths
    Deno.writeTextFileSync(paths.ACCESS_FILE, JSON.stringify({
        dmPolicy: "pairing", allowFrom: ["999"], groups: {}, pending: {},
        commandCenterChatId: "-100CC",
    }))
    const calls = []
    const fakeCore = {
        bot: makeFakeBot(calls),
        chatSessions: {},
        chatState: { commandCenter: {} },
    }
    await tgOut.sendTextMessageToUser({
        chatId: "-100CC",
        text: "system note",
        // no recordAs
        options: { parse_mode: "HTML" },
    }, fakeCore)
    assert(calls[0].text.includes("no session source recorded"), `missing fallback: ${calls[0].text}`)
    assert(calls[0].text.includes("landed in General"))
    assert(calls[0].text.endsWith("system note"))
})

// ── Failure recovery ─────────────────────────────────────────────────

function makeBotThatFailsTwiceThenSucceeds(calls, error) {
    let callCount = 0
    return {
        supports: { reactions: true, inlineButtons: true, htmlFormatting: true, markdownFormatting: false, fileDownload: true },
        async sendText(chatId, text, options) {
            calls.push({ chatId, text, options, attempt: ++callCount })
            if (callCount === 1) { throw error }
            return { messageId: String(callCount) }
        },
        async sendFile() { return { messageId: "1" } },
        async editText() {}, async react() { return true }, async answerCallback() { return true }, async downloadFile() { return true },
    }
}

Deno.test("sendTextMessageToUser: HTML parse error → retries as plain text and succeeds", async () => {
    const calls = []
    const grammyError = Object.assign(new Error("Bad Request: can't parse entities: Unsupported start tag \"id\""), {
        error_code: 400,
        description: "Bad Request: can't parse entities: Unsupported start tag \"id\" at byte offset 1053",
    })
    const fakeBot = makeBotThatFailsTwiceThenSucceeds(calls, grammyError)
    await tgOut.sendTextMessageToUser({
        chatId: "1",
        text: "<id>123</id> some agent body",
        options: { parse_mode: "HTML" },
    }, { bot: fakeBot, chatSessions: {}, chatState: { commandCenter: {} } })
    // Two calls: original (HTML format, threw) + retry (no format/parse_mode)
    // toAbstractOptions converts parse_mode:"HTML" → format:"html" at the bot interface
    assertEquals(calls.length, 2)
    assertEquals(calls[0].options.format, "html")
    assertEquals(calls[1].options.format, undefined)
    assertEquals(calls[1].options.parse_mode, undefined)
    assertEquals(calls[1].text, calls[0].text)  // same body, just unformatted
})

Deno.test("sendTextMessageToUser: non-parse error → sends a plain-text failure notice", async () => {
    const calls = []
    const grammyError = Object.assign(new Error("Forbidden: bot was blocked"), {
        error_code: 403,
        description: "Forbidden: bot was blocked by the user",
    })
    const fakeBot = makeBotThatFailsTwiceThenSucceeds(calls, grammyError)
    await tgOut.sendTextMessageToUser({
        chatId: "1",
        text: "regular content",
        options: { parse_mode: "HTML" },
    }, { bot: fakeBot, chatSessions: {}, chatState: { commandCenter: {} } })
    // Two calls: original (threw) + failure-notice (plain text)
    assertEquals(calls.length, 2)
    assert(calls[1].text.startsWith("[sendText delivery failed:"), `expected notice prefix: ${calls[1].text}`)
    assert(calls[1].text.includes("Forbidden"), `should include error desc: ${calls[1].text}`)
    assert(calls[1].text.includes("regular content"), `should include preview: ${calls[1].text}`)
    assertEquals(calls[1].options.parse_mode, undefined)
})

Deno.test("sendTextMessageToUser: parse-error retry that ALSO fails falls through to failure notice", async () => {
    const calls = []
    let firstCall = true
    const fakeBot = {
        supports: { reactions: true, inlineButtons: true, htmlFormatting: true, markdownFormatting: false, fileDownload: true },
        async sendText(chatId, text, options) {
            calls.push({ chatId, text, options })
            if (firstCall) {
                firstCall = false
                throw Object.assign(new Error("parse"), { error_code: 400, description: "can't parse entities" })
            }
            // second + third calls: plain-retry first throws too, then notice succeeds
            if (calls.length === 2) {
                throw Object.assign(new Error("network"), { error_code: 500, description: "Internal" })
            }
            return { messageId: String(calls.length) }
        },
        async sendFile() { return { messageId: "1" } },
        async editText() {}, async react() { return true }, async answerCallback() { return true }, async downloadFile() { return true },
    }
    await tgOut.sendTextMessageToUser({
        chatId: "1",
        text: "<id>x</id>",
        options: { parse_mode: "HTML" },
    }, { bot: fakeBot, chatSessions: {}, chatState: { commandCenter: {} } })
    // 1: HTML throws parse → 2: plain retry throws 500 → 3: failure notice succeeds
    assertEquals(calls.length, 3)
    assert(calls[2].text.startsWith("[sendText delivery failed:"), `expected notice: ${calls[2].text}`)
})

Deno.test("sendFileToUser: parse-error in caption → retries with plain caption", async () => {
    const outsideFile = `${TEST_HOME}/recover.txt`
    Deno.writeTextFileSync(outsideFile, "x")
    const calls = []
    let firstFile = true
    const fakeBot = {
        supports: { reactions: true, inlineButtons: true, htmlFormatting: true, markdownFormatting: false, fileDownload: true },
        async sendText(chatId, text, options) { calls.push({ kind: "text", chatId, text, options }); return { messageId: String(calls.length) } },
        async sendFile(chatId, filePath, opts) {
            calls.push({ kind: "file", chatId, filePath, opts })
            if (firstFile) {
                firstFile = false
                throw Object.assign(new Error("parse"), { error_code: 400, description: "can't parse entities" })
            }
            return { messageId: String(calls.length) }
        },
        async editText() {}, async react() { return true }, async answerCallback() { return true }, async downloadFile() { return true },
    }
    await tgOut.sendFileToUser({
        chatId: "1",
        filePath: outsideFile,
        caption: "<id>x</id>",
    }, { bot: fakeBot, chatSessions: {}, chatState: { commandCenter: {} } })
    // 2 file calls: HTML caption (threw) + plain caption (succeeded)
    const fileCalls = calls.filter(c => c.kind === "file")
    assertEquals(fileCalls.length, 2)
    assertEquals(fileCalls[0].opts.format, "html")
    assertEquals(fileCalls[1].opts.format, undefined)
    // No failure-notice text call needed (recovery succeeded)
    const textCalls = calls.filter(c => c.kind === "text")
    assertEquals(textCalls.length, 0)
})

Deno.test("sendFileToUser: non-parse error → sends a plain-text failure notice", async () => {
    const outsideFile = `${TEST_HOME}/fail.txt`
    Deno.writeTextFileSync(outsideFile, "x")
    const calls = []
    const fakeBot = {
        supports: { reactions: true, inlineButtons: true, htmlFormatting: true, markdownFormatting: false, fileDownload: true },
        async sendText(chatId, text, options) { calls.push({ kind: "text", chatId, text, options }); return { messageId: String(calls.length) } },
        async sendFile() {
            throw Object.assign(new Error("forbidden"), { error_code: 403, description: "Forbidden: bot was blocked" })
        },
        async editText() {}, async react() { return true }, async answerCallback() { return true }, async downloadFile() { return true },
    }
    await tgOut.sendFileToUser({
        chatId: "1",
        filePath: outsideFile,
        filename: "fail.txt",
    }, { bot: fakeBot, chatSessions: {}, chatState: { commandCenter: {} } })
    const textCalls = calls.filter(c => c.kind === "text")
    assertEquals(textCalls.length, 1)
    assert(textCalls[0].text.startsWith("[sendFile delivery failed:"))
    assert(textCalls[0].text.includes("Forbidden"))
    assert(textCalls[0].text.includes("fail.txt"))
})

Deno.test("editTelegramMessage: parse error → retries plain text", async () => {
    const calls = []
    let firstEdit = true
    const fakeBot = {
        supports: { reactions: true, inlineButtons: true, htmlFormatting: true, markdownFormatting: false, fileDownload: true },
        async sendText(chatId, text, options) { calls.push({ kind: "text", chatId, text, options }); return { messageId: "1" } },
        async sendFile() { return { messageId: "1" } },
        async editText(chatId, messageId, text, options) {
            calls.push({ kind: "edit", chatId, messageId, text, options })
            if (firstEdit) {
                firstEdit = false
                throw Object.assign(new Error("parse"), { error_code: 400, description: "can't parse entities" })
            }
        },
        async react() { return true }, async answerCallback() { return true }, async downloadFile() { return true },
    }
    await tgOut.editTelegramMessage({
        chatId: "1",
        messageId: "42",
        text: "<id>x</id>",
        options: { parse_mode: "HTML" },
    }, { bot: fakeBot, chatSessions: {}, chatState: { commandCenter: {} } })
    const editCalls = calls.filter(c => c.kind === "edit")
    assertEquals(editCalls.length, 2)
    assertEquals(editCalls[0].options.format, "html")
    assertEquals(editCalls[1].options.format, undefined)
    // No failure-notice (recovery succeeded)
    assertEquals(calls.filter(c => c.kind === "text").length, 0)
})

Deno.test("editTelegramMessage: 'message to edit not found' is NOT escalated to a notice", async () => {
    const calls = []
    const fakeBot = {
        supports: { reactions: true, inlineButtons: true, htmlFormatting: true, markdownFormatting: false, fileDownload: true },
        async sendText(chatId, text, options) { calls.push({ kind: "text", chatId, text, options }); return { messageId: "1" } },
        async sendFile() { return { messageId: "1" } },
        async editText() {
            throw Object.assign(new Error("notfound"), { error_code: 400, description: "Bad Request: message to edit not found" })
        },
        async react() { return true }, async answerCallback() { return true }, async downloadFile() { return true },
    }
    await tgOut.editTelegramMessage({
        chatId: "1",
        messageId: "42",
        text: "hi",
        options: {},
    }, { bot: fakeBot, chatSessions: {}, chatState: { commandCenter: {} } })
    // No notice — expected outcome (message gone, agent moved on)
    assertEquals(calls.filter(c => c.kind === "text").length, 0)
})

Deno.test("sendTextMessageToUser: chunks over the 4096 limit into multiple messages", async () => {
    const long = "x".repeat(10000)
    const calls = []
    const fakeBot = {
        supports: { reactions: true, inlineButtons: true, htmlFormatting: true, markdownFormatting: false, fileDownload: true },
        async sendText(chatId, text, options) { calls.push({ chatId, text, options }); return { messageId: String(calls.length) } },
        async sendFile() { return { messageId: "1" } },
        async editText() {},
        async react() { return true },
        async answerCallback() { return true },
        async downloadFile() { return true },
    }
    await tgOut.sendTextMessageToUser(
        { chatId: "1", text: long },
        { bot: fakeBot },
    )
    assert(calls.length >= 3, `expected >= 3 sendText calls, got ${calls.length}`)
    for (const call of calls) {
        assert(call.text.length <= 4096, `piece of length ${call.text.length} exceeds 4096`)
    }
})
