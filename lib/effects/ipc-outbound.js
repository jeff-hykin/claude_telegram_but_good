/**
 * IPC outbound: write a JSON message to a Unix socket connection
 * (a shim or CLI client that contacted us). Framing is newline-delimited
 * JSON to match parseIpcMessages() in lib/ipc.js.
 */

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)

export async function ipcRespond(effect, _core) {
    const { conn, message, closeAfter = false } = effect
    if (!conn) {
        dbg("IPC-OUT", "ipc_respond with no conn")
        return
    }
    try {
        const data = new TextEncoder().encode(JSON.stringify(message) + "\n")
        await conn.write(data)
        if (closeAfter) {
            // Shim conns are long-lived — the IPC translator tags them
            // as `_cbgKind = "shim"` on `register`. A cli_command
            // handler that mistakenly closeAfter's a shim conn would
            // kill the worker session for the rest of its lifetime, so
            // we refuse the close here. CLI client conns have no kind
            // tag and close as normal.
            if (conn._cbgKind === "shim") {
                dbg("IPC-OUT", "refusing to close shim conn (closeAfter ignored)")
                return
            }
            try {
                conn.close()
            } catch (e) {
                dbg("IPC-OUT", "close after respond:", e)
            }
        }
    } catch (e) {
        dbg("IPC-OUT", "write failed:", e)
    }
}
