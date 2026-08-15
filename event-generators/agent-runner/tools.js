// ---------------------------------------------------------------------------
// event-generators/agent-runner/tools.js — the local agent's tool surface.
//
// Two families, deliberately kept in one table:
//
//   LOCAL tools (bash, read_file, write_file, edit_file, list_dir, grep)
//     run right here in the runner process. Claude Code ships its own
//     equivalents; a local model has none, so we supply the minimum a
//     coding agent needs to be useful.
//
//   CHANNEL tools (reply, react, set_title, get_topic_memory,
//     list_sessions, tell_session) are proxied to the daemon as
//     `tool_request` frames — the exact same path the MCP shim uses. This
//     is how the local agent talks to the user at all.
//
// Every execution is bracketed by PreToolUse/PostToolUse hook_event frames
// by the caller (runner.js), which is what drives the Telegram spinner.
// ---------------------------------------------------------------------------

import { dbg } from "../../lib/logging.js"

const MAX_OUTPUT_CHARS = 30_000

function truncate(text) {
    const str = String(text ?? "")
    if (str.length <= MAX_OUTPUT_CHARS) { return str }
    return `${str.slice(0, MAX_OUTPUT_CHARS)}\n… [truncated, ${str.length - MAX_OUTPUT_CHARS} more chars]`
}

function schema(name, description, properties, required) {
    return {
        type: "function",
        function: { name, description, parameters: { type: "object", properties, required } },
    }
}

export const LOCAL_TOOLS = [
    schema("bash", "Run a shell command and return its combined stdout/stderr.", {
        command: { type: "string", description: "the command line to run" },
        timeout_ms: { type: "number", description: "kill the command after this long (default 120000)" },
    }, ["command"]),
    schema("read_file", "Read a UTF-8 text file.", {
        path: { type: "string" },
    }, ["path"]),
    schema("write_file", "Write (or overwrite) a UTF-8 text file.", {
        path: { type: "string" },
        content: { type: "string" },
    }, ["path", "content"]),
    schema("edit_file", "Replace the first occurrence of old_text with new_text in a file.", {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
    }, ["path", "old_text", "new_text"]),
    schema("list_dir", "List the entries of a directory.", {
        path: { type: "string" },
    }, ["path"]),
    schema("grep", "Search files under a directory for a regex, via ripgrep.", {
        pattern: { type: "string" },
        path: { type: "string", description: "directory to search (default: cwd)" },
    }, ["pattern"]),
]

// NOTE: `reply` is deliberately NOT a tool. Small local models are
// unreliable at remembering to call it, and a forgotten reply means a
// silent agent. Instead the runner treats the model's plain assistant
// text as the reply and delivers it itself at end of turn — the model
// just writes. (runner.js still calls the daemon's reply tool directly
// through the link; it's only hidden from the model.)
export const CHANNEL_TOOLS = [
    schema("react", "React to the user's last message with a single emoji.", {
        emoji: { type: "string" },
    }, ["emoji"]),
    schema("set_title", "Set this session's title.", {
        title: { type: "string" },
    }, ["title"]),
    schema("get_topic_memory", "Read this session's persistent topic memory file.", {}, []),
    schema("list_sessions", "List all currently connected cbg sessions.", {}, []),
    schema("tell_session", "Send a message to another cbg session.", {
        target: { type: "string", description: "session id or topic name" },
        text: { type: "string" },
    }, ["target", "text"]),
]

export const ALL_TOOLS = [...CHANNEL_TOOLS, ...LOCAL_TOOLS]

const CHANNEL_TOOL_NAMES = new Set(CHANNEL_TOOLS.map((tool) => tool.function.name))

/**
 * How a local tool call should appear in hook_event frames. The daemon's
 * spinner formatter (lib/pure/hook-format.js) only knows Claude's tool
 * names and input shapes — translating to those buys rich previews
 * ("📖 Reading foo.js", command blocks with output) with zero daemon
 * changes. Channel tools take the mcp__plugin_telegram_ prefix, which the
 * formatter hides — same as for Claude sessions.
 */
export function hookView(name, args) {
    switch (name) {
        case "bash":
            return { toolName: "Bash", toolInput: { command: args.command } }
        case "read_file":
            return { toolName: "Read", toolInput: { file_path: args.path } }
        case "write_file":
            return { toolName: "Write", toolInput: { file_path: args.path } }
        case "edit_file":
            return { toolName: "Edit", toolInput: { file_path: args.path } }
        case "grep":
            return { toolName: "Grep", toolInput: { pattern: args.pattern, path: args.path ?? "." } }
        case "list_dir":
            return { toolName: "Glob", toolInput: { pattern: `${args.path ?? "."}/*` } }
        default:
            if (CHANNEL_TOOL_NAMES.has(name)) {
                return { toolName: `mcp__plugin_telegram_telegram__${name}`, toolInput: args }
            }
            return { toolName: name, toolInput: args }
    }
}

async function runBash(command, cwd, timeoutMs) {
    const proc = new Deno.Command("bash", {
        args: ["-lc", command],
        cwd,
        stdout: "piped",
        stderr: "piped",
    }).spawn()
    const timer = setTimeout(() => {
        try {
            proc.kill("SIGKILL")
        } catch (e) {
            dbg("RUNNER-TOOLS", "bash kill failed:", e)
        }
    }, timeoutMs)
    const output = await proc.output()
    clearTimeout(timer)
    const decoder = new TextDecoder()
    const stdout = decoder.decode(output.stdout)
    const stderr = decoder.decode(output.stderr)
    return `exit=${output.code}\n${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`
}

/**
 * Execute one tool call.
 *
 * @param {string} name
 * @param {object} args
 * @param {{link: DaemonLink, cwd: string, lastInbound: () => ({chatId, messageId}|null)}} ctx
 * @returns {Promise<{output: string, isError: boolean}>}
 */
export async function executeTool(name, args, ctx) {
    try {
        if (CHANNEL_TOOL_NAMES.has(name)) {
            // The daemon's channel handlers speak Telegram's snake_case
            // ids, and a local model shouldn't have to track them — fill
            // them from whatever message last arrived on this session.
            const payload = { ...args }
            if (name === "reply" || name === "react") {
                payload.chat_id = args.chat_id ?? ctx.lastInbound()?.chatId
            }
            if (name === "react") {
                payload.message_id = args.message_id ?? ctx.lastInbound()?.messageId
            }
            const result = await ctx.link.callTool(name, payload)
            if (result == null) {
                return { output: `${name}: no response from the cbg daemon`, isError: true }
            }
            // The daemon answers in MCP shape ({content:[{type:"text",text}]}).
            // Unwrap it, and rewrite terse acks: a small model read "queued"
            // as failure (retried in a loop), and read "done" as the USER
            // saying they were done. The ack must be an unmistakable
            // third-person sentence about the tool.
            let text = typeof result === "string" ? result : JSON.stringify(result)
            if (result?.content?.every?.((part) => part.type === "text")) {
                text = result.content.map((part) => part.text).join("\n")
            }
            if (["queued", "done", "ok", "sent"].includes(text.trim().toLowerCase())) {
                text = `The ${name} action succeeded.`
            }
            return { output: truncate(text), isError: result?.isError === true }
        }

        switch (name) {
            case "bash":
                return { output: truncate(await runBash(args.command, ctx.cwd, args.timeout_ms ?? 120_000)), isError: false }
            case "read_file":
                return { output: truncate(await Deno.readTextFile(args.path)), isError: false }
            case "write_file":
                await Deno.writeTextFile(args.path, args.content)
                return { output: `wrote ${args.content.length} chars to ${args.path}`, isError: false }
            case "edit_file": {
                const before = await Deno.readTextFile(args.path)
                if (!before.includes(args.old_text)) {
                    return { output: `old_text not found in ${args.path}`, isError: true }
                }
                await Deno.writeTextFile(args.path, before.replace(args.old_text, args.new_text))
                return { output: `edited ${args.path}`, isError: false }
            }
            case "list_dir": {
                const entries = []
                for await (const entry of Deno.readDir(args.path)) {
                    entries.push(entry.isDirectory ? `${entry.name}/` : entry.name)
                }
                return { output: truncate(entries.sort().join("\n")), isError: false }
            }
            case "grep":
                return { output: truncate(await runBash(
                    `rg --line-number --no-heading -- ${JSON.stringify(args.pattern)} ${JSON.stringify(args.path ?? ".")}`,
                    ctx.cwd,
                    60_000,
                )), isError: false }
            default:
                return { output: `unknown tool: ${name}`, isError: true }
        }
    } catch (e) {
        dbg("RUNNER-TOOLS", `${name} failed:`, e)
        return { output: `${name} failed: ${e instanceof Error ? e.message : String(e)}`, isError: true }
    }
}
