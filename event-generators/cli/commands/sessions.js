import { versionedImport } from "../../../lib/version.js"

const [
    { colors },
    { paths },
    { dbg },
    { encodeIpcFrame },
] = await Promise.all([
    versionedImport("../../../imports.js", import.meta),
    versionedImport("../../../lib/paths.js", import.meta),
    versionedImport("../../../lib/logging.js", import.meta),
    versionedImport("../../../lib/ipc.js", import.meta),
])
const c = colors

export async function runSessions(_args) {
    const { sendCliCommand } = await versionedImport("../helpers.js", import.meta)
    let reply
    try {
        reply = await sendCliCommand("list_sessions")
    } catch (e) {
        console.error(c.red(`  ${e.message}`))
        Deno.exit(1)
    }
    if (!reply.ok) {
        console.error(c.red(`  Error: ${reply.error}`))
        Deno.exit(1)
    }

    const sessions = reply.sessions ?? []
    if (sessions.length === 0) {
        console.log(c.dim("  No active sessions."))
        return
    }

    console.log()
    console.log(c.bold.white(`  Active sessions (${sessions.length}):`))
    console.log()

    for (const s of sessions) {
        const connected = s.connected ? c.green("connected") : c.dim("disconnected")
        const topic = s.topicName ? c.cyan(s.topicName) : c.dim("(no topic)")
        const title = s.title ? c.white(s.title) : c.dim("(untitled)")
        console.log(`  ${c.bold.cyan(s.id)}  ${topic}  ${title}  ${connected}`)
        if (s.cwd) {
            console.log(`    ${c.dim(s.cwd)}${s.gitBranch ? c.dim(` @ ${s.gitBranch}`) : ""}`)
        }
    }
    console.log()
}
