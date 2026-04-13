import { versionedImport } from "../../../lib/version.js"

const [{ createSession }, { ensureOnboarded }] = await Promise.all([
    versionedImport("../../../lib/dtach.js", import.meta),
    versionedImport("../helpers.js", import.meta),
])

export async function runNew(args) {
    await ensureOnboarded()
    let title
    const claudeArgs = []
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--title" && i + 1 < args.length) {
            title = args[i + 1]
            i++
        } else {
            claudeArgs.push(args[i])
        }
    }
    createSession(title, claudeArgs)
}
