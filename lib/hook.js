// Claude Code PreToolUse/PostToolUse hook — forwards events to cbg server

import { IPC_SOCK, dbg } from "./protocol.js"

// Walk up the process tree to find the Claude Code PID
function findClaudePid() {
    const sh = (cmd) => {
        try {
            const r = new Deno.Command("sh", {
                args: ["-c", cmd], stdout: "piped", stderr: "piped",
            }).outputSync()
            return new TextDecoder().decode(r.stdout).trim()
        } catch { return "" }
    }
    const getppid = (pid) => { const r = sh(`ps -o ppid= -p ${pid}`); return r ? parseInt(r) : -1 }
    const getcomm = (pid) => sh(`ps -o comm= -p ${pid}`) || "?"

    let pid = Deno.pid
    for (let i = 0; i < 10; i++) {
        pid = getppid(pid)
        if (pid <= 1) { break }
        const comm = getcomm(pid)
        dbg("HOOK", `ancestry walk: pid=${pid} comm=${comm}`)
        if (/\bclaude\b/i.test(comm)) {
            dbg("HOOK", `found Claude Code at PID ${pid}`)
            return pid
        }
    }
    const ppid = getppid(Deno.pid)
    dbg("HOOK", "could not find claude in ancestry, falling back to ppid:", ppid)
    return ppid > 0 ? ppid : Deno.pid
}

const claudePid = findClaudePid()

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
