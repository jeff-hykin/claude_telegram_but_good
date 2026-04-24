/**
 * Append an inter-session message to the topic messages.jsonl file(s).
 *
 * effect shape: {
 *     type: "log_inter_session_message",
 *     entry: { ts, from, to, text, source },
 *     topicNames: [topicName, ...]   // which topic dirs to append to
 * }
 *
 * Each topicName gets the entry appended to its messages.jsonl.
 * Directories are created if they don't exist.
 */

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { paths } = await versionedImport("../paths.js", import.meta)

export async function logInterSessionMessage(effect, _core) {
    const { entry, topicNames = [] } = effect
    if (!entry || topicNames.length === 0) {
        dbg("MSG-LOG", "skipping: no entry or no topicNames")
        return
    }
    const line = JSON.stringify(entry) + "\n"
    for (const topicName of topicNames) {
        const filePath = paths.topicMessagesFile(topicName)
        try {
            await Deno.mkdir(paths.topicDir(topicName), { recursive: true })
            const file = await Deno.open(filePath, { write: true, create: true, append: true })
            try {
                await file.write(new TextEncoder().encode(line))
            } finally {
                file.close()
            }
            dbg("MSG-LOG", `appended to ${topicName}/messages.jsonl`)
        } catch (e) {
            dbg("MSG-LOG", `failed to write ${filePath}:`, e)
        }
    }
}
