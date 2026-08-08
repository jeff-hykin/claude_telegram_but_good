/**
 * Shared dtach text-injection helper.
 *
 * Spawns one `dtach -p <socket>` process and types the given text into it
 * one code point at a time with a small pause between characters, then
 * (optionally) submits with a carriage return. dtach forwards the bytes
 * straight to the pty master, so from the attached program's perspective
 * they are indistinguishable from keystrokes typed at a real terminal.
 *
 * Used by:
 *   - lib/effects/dtach-outbound.js (send_raw_input_to_claude effect)
 *   - event-generators/cli/commands/self-input.js (`cbg self-input`)
 *
 * Why char-by-char + a lone carriage return:
 *   Ink (Claude Code's TUI) coalesces a large chunk arriving in a single
 *   read() into a "paste", and a trailing \r inside a paste becomes a
 *   literal newline in the prompt buffer instead of a submit. Typing one
 *   char at a time, then sending 0x0d on its own, makes Ink see a normal
 *   keystroke stream ending in a real Enter. Note: the submit byte MUST be
 *   0x0d (carriage return), NOT 0x0a (line feed) — \n inserts a newline.
 */

import { versionedImport } from "./version.js"

const { dbg } = await versionedImport("./logging.js", import.meta)

const DEFAULT_CHAR_DELAY_MS = 15

// 0x0d (\r / Carriage Return) is the byte a terminal emulator sends when
// the user presses Return in raw mode. Ink treats it as the submit trigger.
const ENTER_KEYSTROKE = new Uint8Array([0x0d])

/**
 * Type `text` into the dtach session at `dtachSocket`, char-by-char.
 *
 * @param {string} dtachSocket  path to the dtach -p socket
 * @param {string} text         text to inject (may be empty → just submit)
 * @param {object} [opts]
 * @param {number} [opts.charDelayMs=15]  pause between characters, in ms
 * @param {boolean} [opts.submit=true]    append a carriage return at the end
 * @param {boolean} [opts.atomic=false]   write the whole string in ONE write.
 *        Required for escape sequences (arrow keys are ESC [ A): a lone ESC
 *        arriving in its own read() is the Escape KEY, so splitting the
 *        sequence would cancel the prompt instead of moving the cursor.
 */
export async function typeIntoDtach(dtachSocket, text, { charDelayMs = DEFAULT_CHAR_DELAY_MS, submit = true, atomic = false } = {}) {
    if (!dtachSocket) {
        throw new Error("typeIntoDtach: no dtach socket provided")
    }
    const proc = new Deno.Command("dtach", {
        args: ["-p", dtachSocket],
        stdin: "piped",
        stdout: "null",
        stderr: "null",
    }).spawn()
    const writer = proc.stdin.getWriter()
    const encoder = new TextEncoder()
    try {
        if (atomic) {
            if ((text ?? "").length > 0) {
                await writer.write(encoder.encode(text))
            }
        } else {
            // Iterate by code point (spread) so multi-byte chars stay intact.
            for (const char of (text ?? "")) {
                await writer.write(encoder.encode(char))
                if (charDelayMs > 0) {
                    await new Promise((resolve) => setTimeout(resolve, charDelayMs))
                }
            }
        }
        if (submit) {
            await writer.write(ENTER_KEYSTROKE)
        }
    } finally {
        await writer.close()
        await proc.status
        dbg("DTACH-INJECT", `typed ${((text ?? "").length)} chars to ${dtachSocket}${submit ? " + Enter" : ""}`)
    }
}
