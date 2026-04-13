import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { paths } = await versionedImport("../paths.js", import.meta)

export default function handle(event, core) {
    const dumpPath = event.targetPath ?? paths.makeDumpPath()
    const snapshot = {
        timestamp: new Date().toISOString(),
        cbgVersion: globalThis.cbgVersion ?? 1,
        chatState: stripPrivate(core.chatState),
        chatSessions: stripPrivate(core.chatSessions),
        specialData: stripPrivate(core.specialData),
    }
    const dumpContent = JSON.stringify(snapshot, null, 2)
    dbg("SERVER-DUMP", `emitting write_file + reply (source=${event.source})`)

    const writeEffect = { type: "write_file", path: dumpPath, content: dumpContent }

    if (event.source === "telegram") {
        return {
            stateChanges: {},
            effects: [
                writeEffect,
                {
                    type: "send_file_to_user",
                    chatId: event.chatId,
                    filePath: dumpPath,
                    filename: "cbg-dump.json",
                },
            ],
        }
    }

    if (event.source === "mcp_tool") {
        return {
            stateChanges: {},
            effects: [
                writeEffect,
                {
                    type: "ipc_respond",
                    conn: event._conn,
                    message: {
                        type: "tool_response",
                        requestId: event.requestId,
                        result: {
                            content: [
                                {
                                    type: "text",
                                    text: JSON.stringify({ logPath: paths.LOG_FILE, dumpPath }),
                                },
                            ],
                        },
                    },
                },
            ],
        }
    }

    dbg("SERVER-DUMP", `unknown source: ${event.source}`)
    return { stateChanges: {}, effects: [writeEffect] }
}

function stripPrivate(value) {
    if (value === null || value === undefined) {
        return value
    }
    if (Array.isArray(value)) {
        return value.map((item) => stripPrivate(item))
    }
    if (typeof value === "object") {
        const out = {}
        for (const key in value) {
            if (key.startsWith("_")) {
                continue
            }
            out[key] = stripPrivate(value[key])
        }
        return out
    }
    if (typeof value === "function") {
        return undefined
    }
    return value
}
