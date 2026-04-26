import { versionedImport } from "../../../lib/version.js"

const [
    { createSession },
    { ensureOnboarded, sendCliCommand },
    { colors },
] = await Promise.all([
    versionedImport("../../../lib/dtach.js", import.meta),
    versionedImport("../helpers.js", import.meta),
    versionedImport("../../../imports.js", import.meta),
])
const c = colors

export async function runNew(args) {
    await ensureOnboarded()

    // --touch <prefixed-name> — ensure-or-create flow via the daemon.
    // Distinct from the legacy positional path so we don't rope title-
    // detection logic into a flag-only operation.
    const touchIdx = args.findIndex(a => a === "--touch")
    if (touchIdx !== -1) {
        const target = args[touchIdx + 1]
        if (!target) {
            console.error(c.red("  --touch requires an argument like topic:<name>, session:<id>, or title:<sub>"))
            Deno.exit(1)
        }
        await runTouch(target)
        return
    }

    let title
    let detached = false
    const claudeArgs = []
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--title" && i + 1 < args.length) {
            title = args[i + 1]
            i++
        } else if (args[i] === "--detach" || args[i] === "-d") {
            detached = true
        } else if (!title && !args[i].startsWith("-")) {
            // First positional arg is the title
            title = args[i]
        } else {
            claudeArgs.push(args[i])
        }
    }
    const sessionId = createSession(title, claudeArgs, { detached })
    if (detached && sessionId) {
        console.log(sessionId)
    }
}

async function runTouch(target) {
    let reply
    try {
        // Spawn can take a couple of seconds (dtach + Claude trust patch).
        // Daemon responds as soon as it has the projected info — no wait
        // for the shim to actually register.
        reply = await sendCliCommand("touch_session", { target }, { timeoutMs: 30000 })
    } catch (e) {
        console.error(c.red(`  ${e.message}`))
        Deno.exit(1)
    }
    if (!reply.ok) {
        console.error(c.red(`  ${reply.error}`))
        Deno.exit(1)
    }
    console.log(JSON.stringify(reply.info, null, 2))
}
