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
export { Server as McpServer } from "https://esm.sh/@modelcontextprotocol/sdk@1.29.0/server/index.js"
export { StdioServerTransport } from "https://esm.sh/@modelcontextprotocol/sdk@1.29.0/server/stdio.js"
export {
    ListToolsRequestSchema,
    CallToolRequestSchema,
} from "https://esm.sh/@modelcontextprotocol/sdk@1.29.0/types.js"

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

// === cliffy (interactive prompts) ===
export { Select } from "https://esm.sh/jsr/@cliffy/prompt@1.0.0"

// === timeago ===
export { format as timeago } from "https://esm.sh/timeago.js@4.0.2"
