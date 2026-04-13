// ---------------------------------------------------------------------------
// lib/pure/html.js — Telegram HTML escaping.
//
// Pure, zero-dependency. Safe to import from any runtime (Deno lib code,
// hot-reloadable Node-style commands). CLAUDE.md mandates HTML parse_mode
// for all Telegram messages, so every handler that interpolates user
// content into HTML strings must run it through escapeHtml first.
//
// Covers the three characters Telegram's HTML parser cares about:
//     &  →  &amp;
//     <  →  &lt;
//     >  →  &gt;
//
// The input is coerced with String(...) so passing a number, null, or
// undefined produces the stringified form instead of throwing.
// ---------------------------------------------------------------------------

export function escapeHtml(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
}
