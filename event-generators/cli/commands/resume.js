import { versionedImport } from "../../../lib/version.js"

const [
    { Select, colors },
    { attachSession, listDtachSockets, resolveSessionName },
    { dbg },
] = await Promise.all([
    versionedImport("../../../imports.js", import.meta),
    versionedImport("../../../lib/dtach.js", import.meta),
    versionedImport("../../../lib/logging.js", import.meta),
])
const c = colors

function formatSessionLabel(s) {
    if (s.title) {
        return `${s.title}  ${c.dim(`(${s.id})`)}`
    }
    return s.id
}

export async function runResume(args) {
    if (args[0]) {
        const name = args.join(" ")
        const resolved = resolveSessionName(name)
        if (resolved) {
            attachSession(resolved)
        } else {
            // Fall back to treating it as a raw session ID
            attachSession(name)
        }
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
                name: formatSessionLabel(s),
                value: s.id,
            })),
            search: true,
        })
        attachSession(selected)
    } catch (e) {
        dbg("CBG", "Select.prompt failed, falling back to list:", e)
        console.log(c.bold.white("  Active dtach sessions:"))
        for (const s of sockets) {
            const titlePart = s.title ? `  ${c.white(s.title)}` : ""
            console.log(`    ${c.cyan(s.id)}${titlePart}  ${c.dim(s.socketPath)}`)
        }
        console.log(c.dim("\n  Usage: ") + c.white("cbg resume <name-or-id>"))
    }
}
