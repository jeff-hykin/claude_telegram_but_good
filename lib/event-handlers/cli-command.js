import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { paths } = await versionedImport("../paths.js", import.meta)

export default function handle(event, core) {
    const kind = event.kind
    const payload = event.payload ?? {}
    const conn = event._conn

    if (kind === "set_pending_otp") {
        const otp = payload.otp
        if (!otp) {
            return respond(conn, { ok: false, error: "missing otp" })
        }
        dbg("CLI-CMD", `set_pending_otp: stored otp=${otp}`)
        return {
            stateChanges: {
                chatState: {
                    pendingOtps: {
                        [otp]: { createdAt: event.ts, chatId: null },
                    },
                },
            },
            effects: [
                {
                    type: "ipc_respond",
                    conn,
                    message: { ok: true },
                    closeAfter: true,
                },
            ],
        }
    }

    if (kind === "reload_cbg") {
        // Compute the new version WITHOUT mutating globalThis — tooling
        // will apply the bump. The reply embeds the projected new version.
        const currentVersion = globalThis.cbgVersion ?? 1
        const newVersion = currentVersion + 1
        dbg("CLI-CMD", `reload_cbg: projecting version ${currentVersion} -> ${newVersion}`)
        return {
            stateChanges: {},
            effects: [
                { type: "bump_cbg_version", toVersion: newVersion },
                {
                    type: "ipc_respond",
                    conn,
                    message: { ok: true, version: newVersion },
                    closeAfter: true,
                },
            ],
        }
    }

    if (kind === "get_cbg_version") {
        const version = globalThis.cbgVersion ?? 1
        return respond(conn, { ok: true, version })
    }

    if (kind === "server_dump") {
        const dumpPath = payload.targetPath ?? paths.makeDumpPath()
        const snapshot = {
            timestamp: new Date().toISOString(),
            cbgVersion: globalThis.cbgVersion ?? 1,
            chatState: stripPrivate(core.chatState),
            chatSessions: stripPrivate(core.chatSessions),
            specialData: stripPrivate(core.specialData),
        }
        dbg("CLI-CMD", `server_dump: emitting write_file for ${dumpPath}`)
        return {
            stateChanges: {},
            effects: [
                { type: "write_file", path: dumpPath, content: JSON.stringify(snapshot, null, 2) },
                {
                    type: "ipc_respond",
                    conn,
                    message: { ok: true, dumpPath },
                    closeAfter: true,
                },
            ],
        }
    }

    if (kind === "shutdown") {
        dbg("CLI-CMD", "shutdown: reply sent, shell will handle actual shutdown")
        return respond(conn, { ok: true })
    }

    dbg("CLI-CMD", `unknown kind: ${kind}`)
    return respond(conn, { ok: false, error: "unknown kind" })
}

function respond(conn, message) {
    return {
        stateChanges: {},
        effects: [
            {
                type: "ipc_respond",
                conn,
                message,
                closeAfter: true,
            },
        ],
    }
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
