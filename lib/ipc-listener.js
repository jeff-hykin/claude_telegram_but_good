import { versionedImport } from "./version.js"

const { dbg } = await versionedImport("./logging.js", import.meta)

// A failed listener must be replaced, not abandoned while the bot keeps
// reporting itself healthy. Accepted connections survive listener replacement.
export async function acceptIpcConnections({ listener, reopen, onConnection, isStopping, sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)) }) {
    let failures = 0
    while (!isStopping()) {
        try {
            if (!listener) {
                listener = reopen()
            }
            const conn = await listener.accept()
            failures = 0
            onConnection(conn)
        } catch (e) {
            if (isStopping()) { return }
            failures++
            dbg("IPC", `accept failed (${failures}):`, e)
            if (failures >= 3) {
                if (listener) {
                    try { listener.close() } catch (closeError) { dbg("IPC", "failed listener close:", closeError) }
                }
                listener = null
                dbg("IPC", "recreating failed listener")
            }
            await sleep(Math.min(failures * 100, 5000))
        }
    }
}
