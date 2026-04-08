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
export {
    join,
    extname,
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
