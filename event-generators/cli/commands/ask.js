/**
 * cbg ask --sync --question "msg" --from <inbox> --to <target>
 *
 * Sends a question to a target session/inbox and blocks until a reply
 * arrives. The target session sees a message with a reply hint pointing
 * to the --from address, so tell_session writes the response to that
 * inbox — and the daemon pushes it back down this CLI's IPC connection.
 *
 * Event-driven: the daemon parks the conn in core.inboxWaiters and
 * wakes it up on the first matching inbox write. No polling. If the
 * daemon dies or restarts, the conn drops and this CLI exits.
 */

import { versionedImport } from "../../../lib/version.js"

const [
    { colors },
    { paths },
    { encodeIpcFrame, parseIpcMessages },
] = await Promise.all([
    versionedImport("../../../imports.js", import.meta),
    versionedImport("../../../lib/paths.js", import.meta),
    versionedImport("../../../lib/ipc.js", import.meta),
])
const c = colors

function parseArgs(args) {
    const result = { sync: false, question: null, from: null, to: null, queueUntilIdle: false }
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--sync") {
            result.sync = true
        } else if (args[i] === "--que" || args[i] === "--queue") {
            result.queueUntilIdle = true
        } else if (args[i] === "--question" && i + 1 < args.length) {
            result.question = args[++i]
        } else if (args[i] === "--from" && i + 1 < args.length) {
            result.from = args[++i]
        } else if (args[i] === "--to" && i + 1 < args.length) {
            result.to = args[++i]
        }
    }
    return result
}

export async function runAsk(args) {
    const opts = parseArgs(args)

    if (!opts.sync) {
        console.error(c.red("  --sync is required (blocking mode)"))
        Deno.exit(1)
    }
    if (!opts.question) {
        console.error(c.red("  --question is required"))
        Deno.exit(1)
    }
    if (!opts.from) {
        console.error(c.red("  --from is required (inbox address for the reply)"))
        Deno.exit(1)
    }
    if (!opts.to) {
        console.error(c.red("  --to is required (target session/address)"))
        Deno.exit(1)
    }

    // Pre-create the inbox dir so concurrent readers (cbg inbox latest)
    // can stat it even before any message has landed.
    await Deno.mkdir(paths.inboxDir(opts.from), { recursive: true })

    // Long-lived IPC conn to the daemon — stays open until the daemon
    // writes the reply frame (or the daemon/CLI dies).
    let conn
    try {
        conn = await Deno.connect({ transport: "unix", path: paths.IPC_SOCK })
    } catch (e) {
        console.error(c.red(`  Cannot reach cbg daemon at ${paths.IPC_SOCK}: ${e.message}`))
        Deno.exit(1)
    }

    try {
        await conn.write(encodeIpcFrame({
            type: "cli_command",
            kind: "ask_sync",
            payload: { target: opts.to, text: opts.question, replyToInbox: opts.from, queueUntilIdle: opts.queueUntilIdle },
        }))
    } catch (e) {
        console.error(c.red(`  Failed to send: ${e.message}`))
        try { conn.close() } catch { /* already closed */ }
        Deno.exit(1)
    }

    console.error(c.dim(`  Sent to ${opts.to}. Waiting for reply in inbox "${opts.from}"...`))

    // Block on the conn until we read one full IPC frame. The daemon
    // sends exactly one reply (success or error) then closes.
    const decoder = new TextDecoder()
    const buf = new Uint8Array(8192)
    let readBuffer = ""
    let response = null
    while (response === null) {
        let n
        try {
            n = await conn.read(buf)
        } catch (e) {
            console.error(c.red(`  IPC read error: ${e.message}`))
            Deno.exit(1)
        }
        if (n == null) {
            console.error(c.red("  Daemon closed connection before replying"))
            Deno.exit(1)
        }
        const parsed = parseIpcMessages(readBuffer, decoder.decode(buf.subarray(0, n)))
        readBuffer = parsed.remaining
        if (parsed.messages.length > 0) {
            response = parsed.messages[0]
        }
    }
    try { conn.close() } catch { /* already closed */ }

    if (!response.ok) {
        console.error(c.red(`  ${response.error ?? "unknown error"}`))
        Deno.exit(1)
    }

    console.log(JSON.stringify(response.message, null, 2))
    Deno.exit(0)
}
