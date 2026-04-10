// Claude Code PreToolUse/PostToolUse hook — forwards events to cbg server

import { IPC_SOCK, dbg, findClaudePid } from "./protocol.js"

const claudePid = findClaudePid(Deno.pid)

const input = await new Response(Deno.stdin.readable).text()

let hook = "unknown", tool = "unknown", session = "unknown"
let inputPreview = "", outputPreview = "", isError = false

try {
    const data = JSON.parse(input)
    hook = data.hook_event_name ?? "unknown"
    tool = data.tool_name ?? "unknown"
    session = data.session_id ?? "unknown"
    const ti = data.tool_input ?? {}
    const compact = {}
    if (ti.file_path) { compact.file_path = ti.file_path }
    if (ti.command) { compact.command = String(ti.command).slice(0, 300) }
    if (ti.description) { compact.description = String(ti.description).slice(0, 100) }
    if (ti.pattern) { compact.pattern = String(ti.pattern).slice(0, 100) }
    if (ti.path) { compact.path = ti.path }
    if (ti.prompt) { compact.prompt = String(ti.prompt).slice(0, 200) }
    inputPreview = JSON.stringify(compact)
    outputPreview = JSON.stringify(data.tool_response ?? "").slice(0, 300)
    isError = !!data.tool_response?.error
} catch (e) {
    dbg("HOOK",`JSON parse failed: ${e instanceof Error ? e.message : String(e)}`)
}

dbg("HOOK", `hook=${hook} tool=${tool} session=${session}`)

try {
    const conn = await Deno.connect({ transport: "unix", path: IPC_SOCK })
    const msg = JSON.stringify({
        type: "hook_event",
        sessionId: session,
        claudePid,
        hook,
        tool_name: tool,
        input_preview: inputPreview,
        output_preview: outputPreview,
        is_error: isError,
    })
    await conn.write(new TextEncoder().encode(msg + "\n"))
    try { await conn.closeWrite() } catch { /* ignore */ }
    const buf = new Uint8Array(1)
    await Promise.race([
        conn.read(buf),
        new Promise(r => setTimeout(r, 500)),
    ])
    conn.close()
} catch (e) {
    dbg("HOOK",`IPC send failed: ${e instanceof Error ? e.message : String(e)}`)
}
