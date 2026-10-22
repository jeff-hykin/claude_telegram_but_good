/**
 * cbg question --text "still want this?" --options "Keep,Drop" [--sync]
 *
 * Ask the user a multiple-choice question they answer by TAPPING A BUTTON in
 * Telegram, from anything that can run a command — a shell script, a cron
 * job, a non-Claude harness. The Claude-session equivalent is the
 * `ask_user_question` MCP tool; a slash command returns an
 * `ask_user_question` follow-up event. All three land in the same handler.
 *
 * Two modes:
 *   default  — print the question id and exit. The answer is written to an
 *              inbox (`--from`, else the question id) and can be read later
 *              with `cbg inbox latest --address <addr>`. Right for anything
 *              that shouldn't hold a process open waiting on a human.
 *   --sync   — park on the inbox and block until the tap comes in, then
 *              print the answer as JSON. The daemon holds this conn open, so
 *              a daemon restart ends the wait (the answer still lands in the
 *              inbox, and the question keeps working).
 */

import { versionedImport } from "../../../lib/version.js"

const [
    { colors },
    { paths },
    { writeIpcFrame, parseIpcMessages },
] = await Promise.all([
    versionedImport("../../../imports.js", import.meta),
    versionedImport("../../../lib/paths.js", import.meta),
    versionedImport("../../../lib/ipc.js", import.meta),
])
const c = colors

function parseArgs(args) {
    const result = {
        sync: false, text: null, options: null, context: null,
        from: null, to: null, chat: null, timeout: null,
    }
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (arg === "--sync") {
            result.sync = true
        } else if ((arg === "--text" || arg === "--question") && i + 1 < args.length) {
            result.text = args[++i]
        } else if (arg === "--options" && i + 1 < args.length) {
            result.options = args[++i]
        } else if (arg === "--context" && i + 1 < args.length) {
            result.context = args[++i]
        } else if (arg === "--from" && i + 1 < args.length) {
            result.from = args[++i]
        } else if (arg === "--to" && i + 1 < args.length) {
            result.to = args[++i]
        } else if (arg === "--chat" && i + 1 < args.length) {
            result.chat = args[++i]
        } else if (arg === "--timeout" && i + 1 < args.length) {
            result.timeout = Number(args[++i])
        }
    }
    return result
}

export async function runQuestion(args) {
    const opts = parseArgs(args)

    if (!opts.text) {
        console.error(c.red("  --text is required"))
        Deno.exit(1)
    }
    if (!opts.options) {
        console.error(c.red(`  --options is required (e.g. --options "Keep,Drop")`))
        Deno.exit(1)
    }
    const options = opts.options.split(",").map((o) => o.trim()).filter(Boolean)
    if (options.length < 2) {
        console.error(c.red("  --options needs at least two comma-separated labels"))
        Deno.exit(1)
    }

    // --sync has to park on an inbox: that is what the answer wakes up.
    // Without an explicit --from we make one, so two concurrent callers
    // never land on the same address and evict each other.
    const waitInbox = opts.sync
        ? (opts.from ?? `cliq_${Date.now().toString(36)}${Math.floor(Math.random() * 0xffff).toString(16)}`)
        : null
    const answerTo = opts.to ?? (opts.from ? `inbox:${opts.from}` : (waitInbox ? `inbox:${waitInbox}` : null))

    if (waitInbox) {
        await Deno.mkdir(paths.inboxDir(waitInbox), { recursive: true })
    }

    let conn
    try {
        conn = await Deno.connect({ transport: "unix", path: paths.IPC_SOCK })
    } catch (e) {
        console.error(c.red(`  Cannot reach cbg daemon at ${paths.IPC_SOCK}: ${e.message}`))
        Deno.exit(1)
    }

    try {
        await writeIpcFrame(conn, {
            type: "cli_command",
            kind: "ask_user_question",
            payload: {
                question: opts.text,
                options,
                context: opts.context,
                answerTo,
                chatId: opts.chat,
                ttlSeconds: opts.timeout,
                waitInbox,
            },
        })
    } catch (e) {
        console.error(c.red(`  Failed to send: ${e.message}`))
        try { conn.close() } catch (closeErr) { console.error(c.dim(`  (close failed: ${closeErr.message})`)) }
        Deno.exit(1)
    }

    // The daemon sends an ack frame first (the question id), then — in sync
    // mode — a second frame carrying the answer when the button is tapped.
    const decoder = new TextDecoder()
    const buf = new Uint8Array(8192)
    let readBuffer = ""
    let acked = false

    while (true) {
        let n
        try {
            n = await conn.read(buf)
        } catch (e) {
            console.error(c.red(`  IPC read error: ${e.message}`))
            Deno.exit(1)
        }
        if (n == null) {
            console.error(c.red(acked
                ? "  Daemon closed the connection before the question was answered (the answer will still land in the inbox)"
                : "  Daemon closed the connection before acknowledging"))
            Deno.exit(1)
        }
        const parsed = parseIpcMessages(readBuffer, decoder.decode(buf.subarray(0, n)))
        readBuffer = parsed.remaining
        for (const frame of parsed.messages) {
            if (!frame.ok) {
                console.error(c.red(`  ${frame.error ?? "unknown error"}`))
                Deno.exit(1)
            }
            if (!acked) {
                acked = true
                if (!opts.sync) {
                    try { conn.close() } catch (e) { console.error(c.dim(`  (close failed: ${e.message})`)) }
                    console.log(JSON.stringify({
                        question_id: frame.questionId,
                        expires_at: frame.expiresAt ? new Date(frame.expiresAt).toISOString() : null,
                        answer_to: answerTo,
                    }, null, 2))
                    Deno.exit(0)
                }
                console.error(c.dim(`  Asked (${frame.questionId}). Waiting for a tap…`))
                continue
            }
            // sync mode, second frame: the answer (or the expiry notice).
            try { conn.close() } catch (e) { console.error(c.dim(`  (close failed: ${e.message})`)) }
            console.log(JSON.stringify(frame.message?.meta ?? frame.message, null, 2))
            Deno.exit(frame.message?.meta?.status === "answered" ? 0 : 2)
        }
    }
}
