import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts"

// IMPORTANT: set HOME and CBG_DIR BEFORE importing cold-storage,
// so lib/paths.js captures the temp paths rather than the real ~/.local/share.
const TEST_HOME = Deno.makeTempDirSync({ prefix: "cbg-cold-test-" })
Deno.env.set("HOME", TEST_HOME)
Deno.env.set("CBG_DIR", `${TEST_HOME}/.local/share/cbg`)

const cs = await import("../lib/cold-storage.js")
const {
    appendColdEntry,
    appendColdMessage,
    appendColdLongTaskEvent,
    appendColdHookEvent,
    readColdStream,
    tailColdStream,
    tailMessagesByChatId,
    findLongTaskHistory,
    COLD_DIR,
} = cs

// Each test clears the cold-storage dir so tests don't leak state into each other.
function resetCold() {
    try {
        Deno.removeSync(COLD_DIR, { recursive: true })
    } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) {
            throw e
        }
    }
}

Deno.test("appendColdMessage + readColdStream round-trip", () => {
    resetCold()
    appendColdMessage({ chatId: "123", from: "user", text: "hello" })
    const out = readColdStream("messages")
    assertEquals(out.length, 1)
    assertEquals(out[0].chatId, "123")
    assertEquals(out[0].from, "user")
    assertEquals(out[0].text, "hello")
    assertExists(out[0].ts)
})

Deno.test("timestamp is auto-added if missing", () => {
    resetCold()
    const before = Date.now()
    appendColdEntry("messages", { chatId: "1", text: "no ts here" })
    const after = Date.now()
    const out = readColdStream("messages")
    assertEquals(out.length, 1)
    assertExists(out[0].ts)
    // Should be a number in the range [before, after]
    assertEquals(typeof out[0].ts, "number")
    if (out[0].ts < before || out[0].ts > after) {
        throw new Error(`ts ${out[0].ts} not in [${before}, ${after}]`)
    }
})

Deno.test("existing ts is preserved, not overwritten", () => {
    resetCold()
    appendColdEntry("messages", { ts: 42, chatId: "1", text: "fixed ts" })
    const out = readColdStream("messages")
    assertEquals(out.length, 1)
    assertEquals(out[0].ts, 42)
})

Deno.test("readColdStream returns [] for missing file", () => {
    resetCold()
    assertEquals(readColdStream("messages"), [])
    assertEquals(readColdStream("long-tasks"), [])
    assertEquals(readColdStream("hooks"), [])
})

Deno.test("tailColdStream returns last N entries", () => {
    resetCold()
    for (let i = 0; i < 10; i++) {
        appendColdMessage({ chatId: "c", seq: i })
    }
    const tail = tailColdStream("messages", 3)
    assertEquals(tail.length, 3)
    assertEquals(tail[0].seq, 7)
    assertEquals(tail[1].seq, 8)
    assertEquals(tail[2].seq, 9)
})

Deno.test("tailColdStream with N > length returns all", () => {
    resetCold()
    appendColdMessage({ chatId: "a", seq: 0 })
    appendColdMessage({ chatId: "a", seq: 1 })
    const tail = tailColdStream("messages", 100)
    assertEquals(tail.length, 2)
})

Deno.test("tailMessagesByChatId filters by chat id", () => {
    resetCold()
    appendColdMessage({ chatId: "A", seq: 0 })
    appendColdMessage({ chatId: "B", seq: 1 })
    appendColdMessage({ chatId: "A", seq: 2 })
    appendColdMessage({ chatId: "B", seq: 3 })
    appendColdMessage({ chatId: "A", seq: 4 })

    const a = tailMessagesByChatId("A", 10)
    assertEquals(a.length, 3)
    assertEquals(a.map(e => e.seq), [0, 2, 4])

    const b = tailMessagesByChatId("B", 10)
    assertEquals(b.length, 2)
    assertEquals(b.map(e => e.seq), [1, 3])

    // Tail with N=1 on chatId A
    const aTail = tailMessagesByChatId("A", 1)
    assertEquals(aTail.length, 1)
    assertEquals(aTail[0].seq, 4)
})

Deno.test("tailMessagesByChatId compares ids as strings (numeric vs string)", () => {
    resetCold()
    appendColdMessage({ chatId: 123, text: "numeric id" })
    appendColdMessage({ chatId: "123", text: "string id" })
    const out = tailMessagesByChatId("123", 10)
    assertEquals(out.length, 2)
})

Deno.test("findLongTaskHistory filters by task id", () => {
    resetCold()
    appendColdLongTaskEvent({ taskId: "t1", state: "started" })
    appendColdLongTaskEvent({ taskId: "t2", state: "started" })
    appendColdLongTaskEvent({ taskId: "t1", state: "progress", pct: 50 })
    appendColdLongTaskEvent({ taskId: "t1", state: "done" })
    appendColdLongTaskEvent({ taskId: "t2", state: "done" })

    const t1 = findLongTaskHistory("t1")
    assertEquals(t1.length, 3)
    assertEquals(t1.map(e => e.state), ["started", "progress", "done"])

    const t2 = findLongTaskHistory("t2")
    assertEquals(t2.length, 2)

    const missing = findLongTaskHistory("nope")
    assertEquals(missing, [])
})

Deno.test("appendColdEntry rejects invalid stream names", () => {
    resetCold()
    let threw = false
    try {
        appendColdEntry("bogus", { foo: 1 })
    } catch (e) {
        threw = true
        assertExists(e)
    }
    if (!threw) {
        throw new Error("expected appendColdEntry to throw on invalid stream")
    }

    // readColdStream should also reject unknown stream names
    let readThrew = false
    try {
        readColdStream("nope")
    } catch {
        readThrew = true
    }
    if (!readThrew) {
        throw new Error("expected readColdStream to throw on invalid stream")
    }
})

Deno.test("malformed lines are skipped without throwing", () => {
    resetCold()
    appendColdMessage({ chatId: "a", text: "good 1" })
    // Manually append a corrupt line between good entries.
    Deno.mkdirSync(COLD_DIR, { recursive: true })
    const path = `${COLD_DIR}/messages.jsonl`
    Deno.writeTextFileSync(path, "this is not json\n", { append: true })
    appendColdMessage({ chatId: "a", text: "good 2" })

    const out = readColdStream("messages")
    assertEquals(out.length, 2)
    assertEquals(out[0].text, "good 1")
    assertEquals(out[1].text, "good 2")
})

Deno.test("multiple appends accumulate correctly across streams", () => {
    resetCold()
    appendColdMessage({ chatId: "a", n: 1 })
    appendColdLongTaskEvent({ taskId: "t", n: 1 })
    appendColdHookEvent({ kind: "PreToolUse", n: 1 })
    appendColdMessage({ chatId: "a", n: 2 })
    appendColdLongTaskEvent({ taskId: "t", n: 2 })
    appendColdHookEvent({ kind: "PostToolUse", n: 2 })

    assertEquals(readColdStream("messages").length, 2)
    assertEquals(readColdStream("long-tasks").length, 2)
    assertEquals(readColdStream("hooks").length, 2)

    // Ordering preserved
    const msgs = readColdStream("messages")
    assertEquals(msgs[0].n, 1)
    assertEquals(msgs[1].n, 2)
})
