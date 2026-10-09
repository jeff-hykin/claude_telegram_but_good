import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { CodexInputQueue } from "../event-generators/agent-runner/codex-input.js"

const deferred = () => {
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
}
const flush = async () => { for (let i = 0; i < 8; i++) { await Promise.resolve() } }

Deno.test("Codex input steers immediately during an active turn, not on the next turn", async () => {
    const calls = []
    const queue = new CodexInputQueue({ request: async (...args) => { calls.push(args) } })
    queue.setActive("thread-a", "turn-a")
    queue.enqueue("Stop that test and inspect the logs")
    await flush()
    assertEquals(calls, [["turn/steer", {
        threadId: "thread-a", expectedTurnId: "turn-a",
        input: [{ type: "text", text: "Stop that test and inspect the logs" }],
    }, 30_000]])
    queue.clearActive()
    assertEquals(await queue.takeBatch(), "")
})

Deno.test("Codex input received while turn/start is pending steers once the id is known", async () => {
    const calls = []
    const queue = new CodexInputQueue({ request: async (_, params) => { calls.push(params) } })
    queue.enqueue("first correction")
    queue.enqueue("second correction")
    assertEquals(calls.length, 0)
    queue.setActive("thread-a", "turn-a")
    await flush()
    assertEquals(calls[0].input[0].text, "first correction\n\nsecond correction")
    assertEquals(await queue.takeBatch(), "")
})

Deno.test("Codex steer rejection preserves FIFO input and does not spin retries", async () => {
    const response = deferred()
    let calls = 0
    const errors = []
    const queue = new CodexInputQueue({ request: () => { calls++; return response.promise }, onError: (e) => errors.push(e.message) })
    queue.setActive("thread-a", "turn-a")
    queue.enqueue("first")
    await flush()
    queue.enqueue("second")
    response.reject(new Error("turn already completed"))
    await flush()
    assertEquals(calls, 1)
    assertEquals(errors, ["turn already completed"])
    queue.clearActive()
    assertEquals(await queue.takeBatch(), "first\n\nsecond")
})

Deno.test("Codex turn completion waits for in-flight steer rejection before next batch", async () => {
    const response = deferred()
    const queue = new CodexInputQueue({ request: () => response.promise })
    queue.setActive("thread-a", "turn-a")
    queue.enqueue("arrived at completion")
    await flush()
    queue.clearActive()
    let drained = false
    const batch = queue.takeBatch().then((text) => { drained = true; return text })
    await flush()
    assertEquals(drained, false)
    queue.enqueue("arrived during reply")
    response.reject(new Error("not active"))
    assertEquals(await batch, "arrived at completion\n\narrived during reply")
})

Deno.test("Codex steers messages arriving during another steer in order", async () => {
    const first = deferred()
    const calls = []
    const queue = new CodexInputQueue({ request: (_, params) => { calls.push(params); return calls.length === 1 ? first.promise : Promise.resolve() } })
    queue.setActive("thread-a", "turn-a")
    queue.enqueue("first")
    await flush()
    queue.enqueue("second")
    queue.enqueue("third")
    assertEquals(calls.length, 1)
    first.resolve({ turnId: "turn-a" })
    await flush()
    assertEquals(calls.map((call) => call.input[0].text), ["first", "second\n\nthird"])
    assertEquals(await queue.takeBatch(), "")
})

Deno.test("Codex system reply rewrites remain queued even with an active turn", async () => {
    let calls = 0
    const queue = new CodexInputQueue({ request: async () => { calls++ } })
    queue.setActive("thread-a", "turn-a")
    queue.enqueue("rewrite your rejected reply", false)
    queue.enqueue("new user input")
    await flush()
    assertEquals(calls, 0)
    queue.clearActive()
    assertEquals(await queue.takeBatch(), "rewrite your rejected reply\n\nnew user input")
})
