import { versionedImport } from "../../../lib/version.js"

const [
    { Select, colors },
    { attachSession, listDtachSockets },
    { dbg },
] = await Promise.all([
    versionedImport("../../../imports.js", import.meta),
    versionedImport("../../../lib/dtach.js", import.meta),
    versionedImport("../../../lib/protocol.js", import.meta),
])
const c = colors

export async function runResume(args) {
    if (args[0]) {
        attachSession(args[0])
        return
    }
    const sockets = listDtachSockets()
    if (sockets.length === 0) {
        console.log(c.yellow("  No active dtach sessions."))
        console.log(c.dim("  Create one with: ") + c.cyan("cbg new"))
        return
    }

    try {
        const selected = await Select.prompt({
            message: "Select a session to resume:",
            options: sockets.map(s => ({
                name: `Session ${s.id}`,
                value: s.id,
            })),
        })
        attachSession(selected)
    } catch (e) {
        dbg("CBG", "Select.prompt failed, falling back to list:", e)
        console.log(c.bold.white("  Active dtach sessions:"))
        for (const s of sockets) {
            console.log(`    ${c.cyan(s.id)}  ${c.dim(s.socketPath)}`)
        }
        console.log(c.dim("\n  Usage: ") + c.white("cbg resume <session-id>"))
    }
}
