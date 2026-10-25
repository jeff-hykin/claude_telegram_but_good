// lib/effects/stale-files.js
//
// `reap_stale_files` — the IO half of lib/event-handlers/stale-state-reaper.js.
// Deletes dtach sockets/logs of sessions cbg no longer tracks and long-task
// directories of tasks it no longer tracks, once they are old enough. A dtach
// socket that still accepts a connection belongs to a running process and is
// never touched, whatever its age. Long-task dirs are only removed when they
// look like a task dir (context/progress/report.md), so hand-made scratch
// folders under long-tasks/ survive.

import { versionedImport } from "../version.js"
const { join } = await versionedImport("../../imports.js", import.meta)
const { dbg } = await versionedImport("../logging.js", import.meta)
const { paths } = await versionedImport("../paths.js", import.meta)

const TASK_DIR_MARKERS = ["context.md", "progress.md", "report.md"]

function mtimeMs(path) {
    try {
        return Deno.statSync(path).mtime?.getTime() ?? 0
    } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) { dbg("REAPER", `stat ${path} failed:`, e) }
        return 0
    }
}

async function socketIsLive(path) {
    try {
        const conn = await Deno.connect({ transport: "unix", path })
        conn.close()
        return true
    } catch (_e) {
        return false
    }
}

function removePath(path, options) {
    try {
        Deno.removeSync(path, options)
        return true
    } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) { dbg("REAPER", `remove ${path} failed:`, e) }
        return false
    }
}

export async function reapStaleFiles(effect, _core) {
    const now = Date.now()
    const keptSessions = new Set(effect.keptSessionIds ?? [])
    const keptTasks = new Set(effect.keptTaskIds ?? [])
    let dtachFiles = 0
    let taskDirs = 0

    const dtachIds = new Set()
    for (const entry of Deno.readDirSync(paths.STATE_DIR)) {
        const match = /^dtach-(.+)\.(sock|log)$/.exec(entry.name)
        if (match) { dtachIds.add(match[1]) }
    }
    for (const sessionId of dtachIds) {
        if (keptSessions.has(sessionId)) { continue }
        const sock = paths.dtachSockFile(sessionId)
        const log = paths.dtachLogFile(sessionId)
        if (now - Math.max(mtimeMs(sock), mtimeMs(log)) < effect.dtachMaxAgeMs) { continue }
        if (await socketIsLive(sock)) { continue }
        dtachFiles += Number(removePath(sock)) + Number(removePath(log))
    }

    try {
        for (const entry of Deno.readDirSync(paths.LONG_TASKS_DIR)) {
            if (!entry.isDirectory || keptTasks.has(entry.name)) { continue }
            const dir = join(paths.LONG_TASKS_DIR, entry.name)
            const markers = TASK_DIR_MARKERS.map(name => join(dir, name)).filter(path => mtimeMs(path) > 0)
            if (markers.length === 0) { continue }
            if (now - Math.max(mtimeMs(dir), ...markers.map(mtimeMs)) < effect.taskDirMaxAgeMs) { continue }
            taskDirs += Number(removePath(dir, { recursive: true }))
        }
    } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) { dbg("REAPER", "scan long-tasks failed:", e) }
    }

    if (dtachFiles || taskDirs) {
        dbg("REAPER", `deleted ${dtachFiles} dtach file(s), ${taskDirs} long-task dir(s)`)
    }
}
