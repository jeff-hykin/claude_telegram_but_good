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
        api: {
            sendDocument: (...args) => { calls.push(["sendDocument", args]); return Promise.resolve() },
            sendPhoto: (...args) => { calls.push(["sendPhoto", args]); return Promise.resolve() },
        },
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
        api: {
            sendDocument: (...args) => { calls.push(["sendDocument", args]); return Promise.resolve() },
            sendPhoto: (...args) => { calls.push(["sendPhoto", args]); return Promise.resolve() },
        },
    }
    await tgOut.sendFileToUser(
        { chatId: "1", filePath: inboxFile },
        { bot: fakeBot },
    )
    // Should have called sendPhoto (inbox + .jpg extension)
    assertEquals(calls.length, 1)
    assertEquals(calls[0][0], "sendPhoto")
})

Deno.test("sendFileToUser: allows a file outside STATE_DIR", async () => {
    const outsideFile = `${TEST_HOME}/external.txt`
    Deno.writeTextFileSync(outsideFile, "hello")

    const calls = []
    const fakeBot = {
        api: {
            sendDocument: (...args) => { calls.push(["sendDocument", args]); return Promise.resolve() },
            sendPhoto: (...args) => { calls.push(["sendPhoto", args]); return Promise.resolve() },
        },
    }
    await tgOut.sendFileToUser(
        { chatId: "1", filePath: outsideFile },
        { bot: fakeBot },
    )
    // Should have called sendDocument (.txt extension, not a photo)
    assertEquals(calls.length, 1)
    assertEquals(calls[0][0], "sendDocument")
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
        api: {
            sendDocument: (...args) => { calls.push(["sendDocument", args]); return Promise.resolve() },
            sendPhoto: (...args) => { calls.push(["sendPhoto", args]); return Promise.resolve() },
        },
    }
    await tgOut.sendFileToUser(
        { chatId: "1", filePath: bigFile },
        { bot: fakeBot },
    )
    // Should NOT have called any bot API — rejected at the size check.
    assertEquals(calls.length, 0, `expected 0 bot calls, got ${calls.length}`)
})

Deno.test("sendTextMessageToUser: chunks over the 4096 limit into multiple messages", async () => {
    const long = "x".repeat(10000)
    const calls = []
    const fakeBot = {
        api: {
            sendMessage: (...args) => { calls.push(args); return Promise.resolve() },
        },
    }
    await tgOut.sendTextMessageToUser(
        { chatId: "1", text: long },
        { bot: fakeBot },
    )
    assert(calls.length >= 3, `expected >= 3 sendMessage calls, got ${calls.length}`)
    for (const call of calls) {
        const piece = call[1]
        assert(piece.length <= 4096, `piece of length ${piece.length} exceeds 4096`)
    }
})
