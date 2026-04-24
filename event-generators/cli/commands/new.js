import { versionedImport } from "../../../lib/version.js"

const [{ createSession }, { ensureOnboarded }] = await Promise.all([
    versionedImport("../../../lib/dtach.js", import.meta),
    versionedImport("../helpers.js", import.meta),
])

export async function runNew(args) {
    await ensureOnboarded()
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
