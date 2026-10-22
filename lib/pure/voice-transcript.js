/**
 * Voice-message transcription helpers (pure).
 *
 * The transcriber is `~/Commands/transcribe`, which prints faster-whisper
 * output in one of two shapes depending on the machine:
 *   macOS — JSONL: {"type":"segment","text":"..."} per line
 *   Linux — one JSON object: {"words":[{"word":" hi"}, ...]}
 * Plain text (e.g. a different command) is accepted as-is.
 */

/** Attachment kinds that carry speech worth transcribing. */
export const TRANSCRIBABLE_KINDS = new Set(["voice", "audio", "video_note"])

/**
 * @param {string} stdout
 * @returns {string|null} the spoken text, or null when there is none
 */
export function parseTranscribeOutput(stdout) {
    const raw = String(stdout ?? "").trim()
    if (!raw) { return null }

    try {
        const whole = JSON.parse(raw)
        if (Array.isArray(whole?.words)) {
            return tidy(whole.words.map((w) => w?.word ?? "").join(""))
        }
        if (typeof whole?.text === "string") { return tidy(whole.text) }
    } catch { /* not a single JSON document — try JSONL */ }

    const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean)
    const segments = []
    let sawJson = false
    for (const line of lines) {
        let obj
        try { obj = JSON.parse(line) } catch { continue }
        sawJson = true
        if (obj?.type === "segment" && typeof obj.text === "string") { segments.push(obj.text) }
    }
    if (sawJson) { return tidy(segments.join(" ")) }
    return tidy(raw)
}

function tidy(text) {
    const t = text.replace(/\s+/g, " ").trim()
    return t || null
}
