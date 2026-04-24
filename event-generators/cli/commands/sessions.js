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

function formatAgo(ts) {
    const ms = Date.now() - ts
    if (ms < 60_000) { return `${Math.floor(ms / 1000)}s ago` }
    if (ms < 3_600_000) { return `${Math.floor(ms / 60_000)}m ago` }
    if (ms < 86_400_000) { return `${Math.floor(ms / 3_600_000)}h ago` }
    return `${Math.floor(ms / 86_400_000)}d ago`
}

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
        const ago = s.lastActive ? formatAgo(s.lastActive) : null
        const lastActiveStr = ago ? c.dim(`  ${ago}`) : ""
        console.log(`  ${c.bold.cyan(s.id)}  ${topic}  ${title}  ${connected}${lastActiveStr}`)
        const details = [s.cwd, s.gitBranch ? `@ ${s.gitBranch}` : "", s.pid ? `pid ${s.pid}` : ""].filter(Boolean).join("  ")
        if (details) {
            console.log(`    ${c.dim(details)}`)
        }
    }
    console.log()
}
