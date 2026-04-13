// ---------------------------------------------------------------------------
// download_complete_for_tool handler.
//
// Synthetic event enqueued by `lib/effects/telegram-download.js` when a
// download triggered by the `download_attachment` MCP tool finishes (or
// fails). Carries the original `requestId` and shim `_conn` so we can
// deliver a `tool_response` back to the Claude session that asked.
//
// Event shape:
//   {
//     type: "download_complete_for_tool",
//     ts: number,
//     fileId: string,
//     requestId: string,
//     imagePath: string | null, // null on failure
//     _conn: UnixConn,
//   }
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)

export default function handle(event, _core) {
    const { requestId, _conn, fileId, imagePath } = event

    if (!_conn || !requestId) {
        dbg("CHANNEL", "download_complete_for_tool: missing _conn or requestId — dropping")
        return { stateChanges: {}, effects: [] }
    }

    if (!imagePath) {
        dbg("CHANNEL", `download_complete_for_tool: failure for ${fileId}`)
        return {
            stateChanges: {},
            effects: [
                {
                    type: "ipc_respond",
                    conn: _conn,
                    message: {
                        type: "tool_response",
                        requestId,
                        result: {
                            content: [
                                {
                                    type: "text",
                                    text: `download_attachment failed for ${fileId}`,
                                },
                            ],
                            isError: true,
                        },
                    },
                },
            ],
        }
    }

    dbg("CHANNEL", `download_complete_for_tool: ${fileId} → ${imagePath}`)
    return {
        stateChanges: {},
        effects: [
            {
                type: "ipc_respond",
                conn: _conn,
                message: {
                    type: "tool_response",
                    requestId,
                    result: {
                        content: [
                            {
                                type: "text",
                                text: `downloaded to ${imagePath}`,
                            },
                        ],
                    },
                },
            },
        ],
    }
}
