// ---------------------------------------------------------------------------
// cbg self-input <text...>
//
// Injects text into the CURRENT session's own dtach socket (read from the
// CBG_DTACH_SOCKET env var that the claude shim sets when it launches a
// session). Types char-by-char then submits with a carriage return — the
// same proven path as the send_raw_input_to_claude effect and the
// /raw_input Telegram command, via the shared lib/dtach-inject.js helper.
//
// This is what lets an agent act on its own session: e.g. the self_compact
// / self_clear skills run `cbg self-input "/compact"` to type /compact into
// their own prompt. With no args it just presses Enter.
//
// Intentionally omitted from `cbg --help`: it's meant to be invoked by a
// running agent (or a skill), not by a human at a fresh shell.
// ---------------------------------------------------------------------------

import { versionedImport } from "../../../lib/version.js"

const { typeIntoDtach } = await versionedImport("../../../lib/dtach-inject.js", import.meta)

export async function runSelfInput(args) {
    const sock = Deno.env.get("CBG_DTACH_SOCKET")
    if (!sock) {
        console.error("cbg self-input: CBG_DTACH_SOCKET is not set — you are not")
        console.error("  running inside a cbg-managed claude session, so there is no")
        console.error("  dtach socket to type into. (Normal `claude` sessions launched")
        console.error("  through the cbg shim have this set automatically.)")
        Deno.exit(1)
    }
    // Join with spaces so unquoted multi-word text still works; a single
    // quoted arg passes through verbatim. Empty → just submit (Enter).
    const text = args.join(" ")
    try {
        await typeIntoDtach(sock, text)
    } catch (e) {
        console.error("cbg self-input: injection failed:", e?.message ?? e)
        Deno.exit(1)
    }
}
