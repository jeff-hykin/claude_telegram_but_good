// imports.js — Consolidated dependency URLs (pinned versions via esm.sh)
//
// Every external import in the project comes through this file.
// To bump a dependency, change the version here and everything updates.

// === grammy (Telegram bot framework) ===
export {
    Bot,
    GrammyError,
    InlineKeyboard,
    InputFile,
} from "https://esm.sh/grammy@1.40.1"

// === MCP SDK (Model Context Protocol) ===
// Vendored from npm:@modelcontextprotocol/sdk@1.12.0 via deno bundle.
// esm.sh's denonext build of zod v4 is broken, so we bundle locally with zod v3.
export { Server as McpServer } from "./vendor/mcp-server.js"
export { StdioServerTransport } from "./vendor/mcp-stdio.js"
export {
    ListToolsRequestSchema,
    CallToolRequestSchema,
} from "./vendor/mcp-types.js"

// === @std/path ===
import { fromFileUrl as _fromFileUrl } from "https://esm.sh/jsr/@std/path@1.1.4"
export {
    join,
    extname,
    basename,
    SEPARATOR,
    fromFileUrl,
    toFileUrl,
} from "https://esm.sh/jsr/@std/path@1.1.4"

// === @std/yaml ===
export {
    parse as parseYaml,
    stringify as stringifyYaml,
} from "https://esm.sh/jsr/@std/yaml@1.0.12"

// === cliffy (interactive prompts + terminal styling) ===
export { Select, Input, Confirm } from "https://esm.sh/jsr/@cliffy/prompt@1.0.0"
export { colors } from "https://esm.sh/jsr/@cliffy/ansi@1.0.0/colors"

// === timeago ===
export { format as timeago } from "https://esm.sh/timeago.js@4.0.2"

// === rrule.js (RFC 5545 recurrence rules) ===
// Used for recurrence-structure logic (freq / byhour / byday / etc.).
// Docs: https://github.com/jkbrzt/rrule
//
// Footgun: rrule@2.8.x's built-in tzid support is broken — byhour is
// interpreted as UTC regardless of the tzid field. We do our own
// timezone correction using luxon (below): run rrule WITHOUT tzid,
// then reinterpret each output's wall-clock components as being in
// the target tz via luxon.DateTime.fromISO(iso, { zone: tzid }).
export { RRule, RRuleSet, rrulestr } from "https://esm.sh/rrule@2.8.1"

// === luxon (timezone-aware date math) ===
// We only need DateTime for tzid conversion around rrule.js. See
// lib/scheduler/index.js for the real→phantom and phantom→real
// helpers that work around rrule.js's tzid bug.
export { DateTime as LuxonDateTime } from "https://esm.sh/luxon@3.5.0"

// === unique-names-generator (session name generator) ===
export {
    uniqueNamesGenerator,
    adjectives as nameAdjectives,
    animals as nameAnimals,
} from "https://esm.sh/unique-names-generator@4.7.1"

// === dax (cross-platform shell + process helpers) ===
// Tagged-template `$\`cmd ${arg}\`` runs a command with proper arg quoting,
// throws on non-zero unless `.noThrow()`, and exposes `.text()`, `.lines()`,
// `.timeout(ms)`, `.env({...})`, `.stdinText("...")`, `.commandExists(bin)`,
// etc. Docs: https://github.com/dsherret/dax
export { default as $ } from "jsr:@david/dax@0.42.0"

// === helpers ===

/**
 * Resolve a sibling path relative to a module's import.meta.url.
 * Works for both file: (local) and https: (remote/URL-installed) modules.
 *
 * Usage: sibling(import.meta, "../main-server.js")
 */
export function sibling(meta, relativePath) {
    const resolved = new URL(relativePath, meta.url)
    if (resolved.protocol === "file:") {
        return _fromFileUrl(resolved)
    }
    return resolved.href
}
