// tests/voice-transcript-test.js
//
// Voice/audio attachments are transcribed before delivery when a
// transcriber is available, and delivered as a bare file otherwise.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, paths } from "./_helpers.js"
import { versionedImport } from "../lib/version.js"

setupTempPaths("cbg-voice-test-")

const { parseTranscribeOutput } = await versionedImport("../lib/pure/voice-transcript.js", import.meta)
const { attachmentMessageText } = await versionedImport("../lib/event-handlers/chat-user.js", import.meta)
const { downloadTelegramFile } = await versionedImport("../lib/effects/telegram-download.js", import.meta)

Deno.test("parseTranscribeOutput: macOS JSONL segments", () => {
    const out = [
        `{"type": "info", "language": "en"}`,
        `{"type": "segment", "start": 0, "end": 1, "text": "Hello there.", "words": []}`,
        `{"type": "segment", "start": 1, "end": 2, "text": "Second bit.", "words": []}`,
    ].join("\n")
    assertEquals(parseTranscribeOutput(out), "Hello there. Second bit.")
})

Deno.test("parseTranscribeOutput: Linux single JSON with words", () => {
    const out = JSON.stringify({ language: "en", words: [{ word: " Hello" }, { word: " world." }] }, null, 2)
    assertEquals(parseTranscribeOutput(out), "Hello world.")
})

Deno.test("parseTranscribeOutput: plain text, and silence", () => {
    assertEquals(parseTranscribeOutput("just text\n"), "just text")
    assertEquals(parseTranscribeOutput(`{"type": "info", "language": "en"}`), null)
    assertEquals(parseTranscribeOutput(""), null)
})

Deno.test("attachmentMessageText: transcript replaces the placeholder caption", () => {
    const att = { kind: "voice" }
    const text = attachmentMessageText(att, "/inbox/v.oga", "(voice message)", "buy milk")
    assertEquals(text, "[Attached file: voice]\nFile path: /inbox/v.oga\n[Voice transcript (whisper)]: buy milk")
})

Deno.test("attachmentMessageText: a real caption is kept next to the transcript", () => {
    const text = attachmentMessageText({ kind: "voice" }, "/inbox/v.oga", "urgent", "buy milk")
    assert(text.includes("urgent"))
    assert(text.includes("buy milk"))
})

Deno.test("attachmentMessageText: no transcript = file only (fallback)", () => {
    const text = attachmentMessageText({ kind: "voice" }, "/inbox/v.oga", "(voice message)", null)
    assertEquals(text, "[Attached file: voice]\nFile path: /inbox/v.oga\n(voice message)")
})

// ── The effect, end to end with a fake bot and a fake transcriber ──────

function writeConfig(obj) {
    Deno.mkdirSync(paths.CONFIG_FILE.replace(/\/[^/]+$/, ""), { recursive: true })
    Deno.writeTextFileSync(paths.CONFIG_FILE, JSON.stringify(obj))
}

function fakeCore() {
    const events = []
    let resolveEnqueued
    const enqueued = new Promise((r) => { resolveEnqueued = r })
    return {
        events,
        enqueued,
        enqueueEvent: (e) => { events.push(e); resolveEnqueued() },
        bot: {
            getFileExtension: () => "oga",
            downloadFile: (_id, path) => { Deno.writeTextFileSync(path, "audio"); return true },
        },
    }
}

const voiceEvent = { chatId: "1", attachment: { kind: "voice", fileId: "F1" }, _downloaded: true }

Deno.test("download effect: voice note gets a transcript from the configured command", async () => {
    const script = Deno.makeTempFileSync({ suffix: ".sh" })
    Deno.writeTextFileSync(script, `#!/bin/sh\necho '{"type": "segment", "text": "hello from whisper"}'\n`)
    Deno.chmodSync(script, 0o755)
    writeConfig({ voice_transcribe_command: script })
    const core = fakeCore()
    await downloadTelegramFile({ type: "download_telegram_file", fileId: "F1", followUpEvent: voiceEvent }, core)
    await core.enqueued
    assertEquals(core.events.length, 1)
    assertEquals(core.events[0].transcript, "hello from whisper")
    assert(core.events[0].imagePath.endsWith(".oga"))
})

Deno.test("download effect: missing transcriber falls back to the bare file", async () => {
    writeConfig({ voice_transcribe_command: "/nonexistent/transcribe-xyz" })
    const core = fakeCore()
    await downloadTelegramFile({ type: "download_telegram_file", fileId: "F1", followUpEvent: voiceEvent }, core)
    await core.enqueued
    assertEquals(core.events[0].transcript, undefined)
    assert(core.events[0].imagePath)
})

Deno.test("download effect: a photo is never sent to the transcriber", async () => {
    writeConfig({ voice_transcribe_command: "/nonexistent/transcribe-xyz" })
    const core = fakeCore()
    const photo = { ...voiceEvent, attachment: { kind: "image", fileId: "F2" } }
    await downloadTelegramFile({ type: "download_telegram_file", fileId: "F2", followUpEvent: photo }, core)
    assertEquals(core.events.length, 1)
    assertEquals(core.events[0].transcript, undefined)
})
