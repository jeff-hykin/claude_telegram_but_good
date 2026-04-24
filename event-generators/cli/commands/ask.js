/**
 * cbg ask --sync --question "msg" --from <inbox> --to <target>
 *
 * Sends a question to a target session/inbox and blocks until a reply
 * appears in the --from inbox. The target session sees a message with
 * a reply hint pointing to the --from address, so tell_session writes
 * the response to the --from inbox. The CLI polls that inbox until a
 * new message appears.
 */

import { versionedImport } from "../../../lib/version.js"

const [
    { colors },
    { readLatestInboxMessage, appendInboxMessage },
    { paths },
] = await Promise.all([
    versionedImport("../../../imports.js", import.meta),
    versionedImport("../../../lib/inbox.js", import.meta),
    versionedImport("../../../lib/paths.js", import.meta),
])
const c = colors

function parseArgs(args) {
    const result = { sync: false, question: null, from: null, to: null }
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--sync") {
            result.sync = true
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

    const { sendCliCommand } = await versionedImport("../helpers.js", import.meta)

    // Initialize the from-inbox so we can detect new messages.
    // Record the current latest message timestamp (if any) so we
    // know to wait for something newer.
    const beforeMsg = readLatestInboxMessage(opts.from)
    const beforeTs = beforeMsg?.ts ?? 0

    // Ensure the inbox dir exists (even if empty) so tell_session
    // can write to it.
    await Deno.mkdir(paths.inboxDir(opts.from), { recursive: true })

    // Send the question via the daemon's tell_session handler.
    // The message includes a reply hint so the agent knows where
    // to send the response.
    let reply
    try {
        reply = await sendCliCommand("tell_session", {
            target: opts.to,
            text: opts.question,
            replyToInbox: opts.from,
        }, { timeoutMs: 10_000 })
    } catch (e) {
        console.error(c.red(`  Failed to send: ${e.message}`))
        Deno.exit(1)
    }

    if (!reply.ok) {
        console.error(c.red(`  ${reply.error}`))
        Deno.exit(1)
    }

    console.error(c.dim(`  Sent to ${opts.to}. Waiting for reply in inbox "${opts.from}"...`))

    // Poll the inbox for a new message (newer than beforeTs).
    const POLL_MS = 500
    while (true) {
        const latest = readLatestInboxMessage(opts.from)
        if (latest && latest.ts > beforeTs) {
            // Got a reply! Output as JSON to stdout.
            console.log(JSON.stringify(latest, null, 2))
            Deno.exit(0)
        }

        // Check if the target session is still alive (if it was a session).
        // We do this by checking the dtach socket.
        try {
            const sessions = await sendCliCommand("list_sessions", {}, { timeoutMs: 5_000 })
            if (sessions.ok) {
                const target = sessions.sessions?.find(s =>
                    s.id === opts.to ||
                    s.topicName?.toLowerCase() === opts.to.toLowerCase() ||
                    (s.title && s.title.toLowerCase().includes(opts.to.toLowerCase()))
                )
                if (target && !target.connected) {
                    console.error(c.red(`  Target session "${opts.to}" disconnected.`))
                    Deno.exit(1)
                }
            }
        } catch {
            // Daemon unreachable — can't check session status
        }

        await new Promise(r => setTimeout(r, POLL_MS))
    }
}
