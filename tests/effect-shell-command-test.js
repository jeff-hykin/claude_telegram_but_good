// tests/effect-shell-command-test.js
//
// Unit tests for lib/effects/shell-command.js — the `#`-prefix shell
// command effect. Uses real `zsh` so we exercise the full spawn path,
// but commands are kept short (echo, sleep, exit) so the suite stays
// snappy.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, makeCore } from "./_helpers.js"

setupTempPaths("cbg-shell-test-")

const { spawnShellCommand } = await import("../lib/effects/shell-command.js")

function recordingBot() {
    const sent = []
    const sentFiles = []
    return {
        sent, sentFiles,
        sendText(chatId, text, options) {
            sent.push({ chatId, text, options })
            return Promise.resolve({ messageId: "1" })
        },
        sendFile(chatId, filePath, options) {
            sentFiles.push({ chatId, filePath, options })
            return Promise.resolve({ messageId: "2" })
        },
    }
}

function replyTo() {
    return { chatId: "100", threadId: 1, setBy: "test" }
}

async function waitForBotMessage(bot, timeoutMs = 5000) {
    const start = Date.now()
    while (bot.sent.length === 0 && bot.sentFiles.length === 0) {
        if (Date.now() - start > timeoutMs) {
            throw new Error("timed out waiting for bot message")
        }
        await new Promise((r) => setTimeout(r, 25))
    }
}

Deno.test("shell-effect: simple echo runs and replies inline", async () => {
    const bot = recordingBot()
    const core = makeCore({ bot })
    await spawnShellCommand({
        type: "shell_command_spawn",
        key: "100:1",
        chatId: "100",
        threadId: 1,
        cmd: "echo hello-world",
        cwd: "/tmp",
        replyTo: replyTo(),
    }, core)
    await waitForBotMessage(bot)
    assertEquals(bot.sent.length, 1)
    const msg = bot.sent[0]
    assertEquals(msg.chatId, "100")
    assert(msg.text.includes("hello-world"), `text was: ${msg.text}`)
    assert(msg.text.includes("$ echo hello-world"))
    // Process map is cleared
    assertEquals(core.activeShellProcs.size, 0)
})

Deno.test("shell-effect: non-zero exit shows exit code", async () => {
    const bot = recordingBot()
    const core = makeCore({ bot })
    await spawnShellCommand({
        type: "shell_command_spawn",
        key: "100:1",
        chatId: "100",
        threadId: 1,
        cmd: "exit 7",
        cwd: "/tmp",
        replyTo: replyTo(),
    }, core)
    await waitForBotMessage(bot)
    assert(bot.sent[0].text.includes("(exit 7)"), `text was: ${bot.sent[0].text}`)
})

Deno.test("shell-effect: cwd is honored", async () => {
    const bot = recordingBot()
    const core = makeCore({ bot })
    const tmp = Deno.makeTempDirSync({ prefix: "cbg-shell-cwd-" })
    Deno.writeTextFileSync(`${tmp}/marker.txt`, "yes")
    await spawnShellCommand({
        type: "shell_command_spawn",
        key: "100:1",
        chatId: "100",
        threadId: 1,
        cmd: "ls",
        cwd: tmp,
        replyTo: replyTo(),
    }, core)
    await waitForBotMessage(bot)
    assert(bot.sent[0].text.includes("marker.txt"), `text was: ${bot.sent[0].text}`)
})

Deno.test("shell-effect: stderr captured separately", async () => {
    const bot = recordingBot()
    const core = makeCore({ bot })
    await spawnShellCommand({
        type: "shell_command_spawn",
        key: "100:1",
        chatId: "100",
        threadId: 1,
        cmd: "echo OUT; echo ERR 1>&2",
        cwd: "/tmp",
        replyTo: replyTo(),
    }, core)
    await waitForBotMessage(bot)
    const text = bot.sent[0].text
    assert(text.includes("OUT"), `text was: ${text}`)
    assert(text.includes("ERR"), `text was: ${text}`)
    assert(text.includes("stderr"), `text was: ${text}`)
})

Deno.test("shell-effect: large output attached as file", async () => {
    const bot = recordingBot()
    const core = makeCore({ bot })
    // Generate ~5000 chars of output — over the inline limit (3500)
    await spawnShellCommand({
        type: "shell_command_spawn",
        key: "100:1",
        chatId: "100",
        threadId: 1,
        cmd: "yes A | head -5000",
        cwd: "/tmp",
        replyTo: replyTo(),
    }, core)
    await waitForBotMessage(bot)
    assertEquals(bot.sentFiles.length, 1)
    const file = bot.sentFiles[0]
    assertEquals(file.options.filename, "output.txt")
    const body = Deno.readTextFileSync(file.filePath)
    assert(body.includes("$ yes A | head -5000"))
    assert(body.includes("--- stdout ---"))
})

Deno.test("shell-effect: rejects second concurrent run for same key", async () => {
    const bot = recordingBot()
    const core = makeCore({ bot })
    // First: a quick command (300ms)
    await spawnShellCommand({
        type: "shell_command_spawn",
        key: "100:1",
        chatId: "100",
        threadId: 1,
        cmd: "sleep 0.3",
        cwd: "/tmp",
        replyTo: replyTo(),
    }, core)
    // Second concurrent attempt — should bounce immediately
    await spawnShellCommand({
        type: "shell_command_spawn",
        key: "100:1",
        chatId: "100",
        threadId: 1,
        cmd: "echo nope",
        cwd: "/tmp",
        replyTo: replyTo(),
    }, core)
    assertEquals(bot.sent.length, 1)
    assert(bot.sent[0].text.includes("Already running"))
    // Wait for first proc to finish (drains the activeShellProcs map)
    while (core.activeShellProcs.size > 0) {
        await new Promise((r) => setTimeout(r, 25))
    }
    // The first proc's completion sent a second message
    assertEquals(bot.sent.length, 2)
})

Deno.test("shell-effect: SIGTERM mid-run reports as cancelled", async () => {
    const bot = recordingBot()
    const core = makeCore({ bot })
    spawnShellCommand({
        type: "shell_command_spawn",
        key: "100:1",
        chatId: "100",
        threadId: 1,
        cmd: "sleep 30",
        cwd: "/tmp",
        replyTo: replyTo(),
    }, core)
    // Wait for the proc to be registered, then cancel it
    while (core.activeShellProcs.size === 0) {
        await new Promise((r) => setTimeout(r, 5))
    }
    const entry = core.activeShellProcs.get("100:1")
    entry.cancelled = true
    entry.proc.kill("SIGTERM")
    await waitForBotMessage(bot, 5000)
    const text = bot.sent[0].text
    assert(text.includes("cancelled"), `text was: ${text}`)
    assertEquals(core.activeShellProcs.size, 0)
})
