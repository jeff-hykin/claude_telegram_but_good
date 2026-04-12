/**
 * Core data model for the long-task subsystem.
 *
 * Manages task directories under $HOME/.cbg/long-tasks/<id>/
 * with in-memory indexes for fast session->task lookups.
 */

import { join } from "../imports.js"
import { HOME, STATE_DIR, dbg, randomHex } from "./protocol.js"
import { getConfig } from "./config.js"

// ── In-memory state ────────────────────────────────────────────────

/** RAM cache of definitions-of-done keyed by taskId */
const definitions = {}

/** Maps sessionId -> taskId for O(1) lookup */
const sessionToTaskId = {}

const TERMINAL_STATES = new Set(["certified", "cancelled"])

const DEFAULT_TASK_DIR = join(HOME, ".cbg", "long-tasks")
const DEFINITIONS_BACKUP_DIR = join(STATE_DIR, "long-task-definitions")

// ── Path helpers ───────────────────────────────────────────────────

export function getTaskDir() {
    return getConfig("long_task_dir") || DEFAULT_TASK_DIR
}

export function taskPath(taskId) {
    return join(getTaskDir(), taskId)
}

// ── String helpers ─────────────────────────────────────────────────

export function slugify(title) {
    return title
        .split(/\s+/)
        .map(w => {
            const clean = w.replace(/[^a-zA-Z0-9]/g, "")
            if (!clean) {
                return ""
            }
            return clean.charAt(0).toUpperCase() + clean.slice(1)
        })
        .join("")
}

export function generateTaskId(title) {
    const slug = slugify(title).slice(0, 30)
    return slug + randomHex(2)
}

// ── Task I/O ───────────────────────────────────────────────────────

export function readTask(taskId) {
    try {
        const raw = Deno.readTextFileSync(join(taskPath(taskId), "task.json"))
        return JSON.parse(raw)
    } catch (e) {
        dbg("LONG-TASK", "readTask failed for", taskId, e)
        return null
    }
}

export function writeTask(taskId, task) {
    const dir = taskPath(taskId)
    const target = join(dir, "task.json")
    const tmp = join(dir, `task.json.tmp.${randomHex(4)}`)
    try {
        Deno.writeTextFileSync(tmp, JSON.stringify(task, null, 4) + "\n")
        Deno.renameSync(tmp, target)
    } catch (e) {
        dbg("LONG-TASK", "writeTask failed for", taskId, e)
        // clean up tmp if rename failed
        try { Deno.removeSync(tmp) } catch (e2) { dbg("LONG-TASK", "tmp cleanup failed:", e2) }
        throw e
    }
}

export function updateTask(taskId, patch) {
    const task = readTask(taskId)
    if (!task) {
        throw new Error(`updateTask: could not read task ${taskId}`)
    }
    const updated = { ...task, ...patch }
    writeTask(taskId, updated)
    return updated
}

// ── Task creation ──────────────────────────────────────────────────

export function createTask({ id, title, originalPrompt, chatId, sessionId, cwd, dtachSocket }) {
    const dir = taskPath(id)
    Deno.mkdirSync(join(dir, "revisions"), { recursive: true })

    const task = {
        id,
        title,
        originalPrompt,
        createdAt: new Date().toISOString(),
        createdBy: { chatId: String(chatId) },
        worker: {
            sessionId,
            cwd,
            dtachSocket: dtachSocket || null,
        },
        state: "defining",
        nudge: {
            lastStopAt: null,
            lastNudgeAt: null,
            consecutiveIdleStops: 0,
            totalNudges: 0,
        },
        critic: {
            callCount: 0,
            lastCallAt: null,
            indecisiveRetries: 0,
        },
    }

    writeTask(id, task)

    // add to in-memory index
    if (sessionId) {
        sessionToTaskId[sessionId] = id
    }

    return task
}

// ── Definitions of done ────────────────────────────────────────────

export function storeDefinition(taskId, markdown) {
    definitions[taskId] = markdown

    // disk backup
    try {
        Deno.mkdirSync(DEFINITIONS_BACKUP_DIR, { recursive: true })
        Deno.writeTextFileSync(join(DEFINITIONS_BACKUP_DIR, `${taskId}.md`), markdown)
    } catch (e) {
        dbg("LONG-TASK", "storeDefinition disk backup failed for", taskId, e)
    }
}

export function getDefinition(taskId) {
    return definitions[taskId] || null
}

export function deleteDefinition(taskId) {
    delete definitions[taskId]

    try {
        Deno.removeSync(join(DEFINITIONS_BACKUP_DIR, `${taskId}.md`))
    } catch (e) {
        dbg("LONG-TASK", "deleteDefinition disk cleanup failed for", taskId, e)
    }
}

export function restoreDefinitionsFromDisk() {
    try {
        Deno.mkdirSync(DEFINITIONS_BACKUP_DIR, { recursive: true })
    } catch (e) {
        dbg("LONG-TASK", "could not ensure definitions backup dir:", e)
        return
    }

    try {
        for (const entry of Deno.readDirSync(DEFINITIONS_BACKUP_DIR)) {
            if (!entry.isFile || !entry.name.endsWith(".md")) {
                continue
            }
            const taskId = entry.name.slice(0, -3)
            const task = readTask(taskId)
            if (task && TERMINAL_STATES.has(task.state)) {
                // skip terminal tasks — don't load their definitions
                continue
            }
            try {
                definitions[taskId] = Deno.readTextFileSync(join(DEFINITIONS_BACKUP_DIR, entry.name))
                dbg("LONG-TASK", "restored definition for", taskId)
            } catch (e) {
                dbg("LONG-TASK", "failed to restore definition for", taskId, e)
            }
        }
    } catch (e) {
        dbg("LONG-TASK", "restoreDefinitionsFromDisk scan failed:", e)
    }
}

// ── Index management ───────────────────────────────────────────────

export function rebuildIndex() {
    // clear existing index
    for (const key of Object.keys(sessionToTaskId)) {
        delete sessionToTaskId[key]
    }

    const base = getTaskDir()
    try {
        Deno.mkdirSync(base, { recursive: true })
    } catch (e) {
        dbg("LONG-TASK", "could not ensure task dir:", e)
        return
    }

    try {
        for (const entry of Deno.readDirSync(base)) {
            if (!entry.isDirectory) {
                continue
            }
            const task = readTask(entry.name)
            if (!task) {
                continue
            }
            if (TERMINAL_STATES.has(task.state)) {
                continue
            }
            const sid = task.worker && task.worker.sessionId
            if (sid) {
                sessionToTaskId[sid] = task.id
            }
        }
    } catch (e) {
        dbg("LONG-TASK", "rebuildIndex scan failed:", e)
    }

    dbg("LONG-TASK", "rebuildIndex complete, indexed", Object.keys(sessionToTaskId).length, "active tasks")
}

export function findActiveTaskForSession(sessionId) {
    const taskId = sessionToTaskId[sessionId]
    if (!taskId) {
        return null
    }
    const task = readTask(taskId)
    if (!task || TERMINAL_STATES.has(task.state)) {
        // stale index entry — clean up
        delete sessionToTaskId[sessionId]
        return null
    }
    return task
}

// ── Task operations ────────────────────────────────────────────────

export function cancelTask(taskId) {
    const task = updateTask(taskId, { state: "cancelled" })
    deleteDefinition(taskId)

    // remove from index
    for (const [sid, tid] of Object.entries(sessionToTaskId)) {
        if (tid === taskId) {
            delete sessionToTaskId[sid]
        }
    }

    return task
}

export function listAllTasks() {
    const base = getTaskDir()
    const tasks = []

    try {
        Deno.mkdirSync(base, { recursive: true })
    } catch (e) {
        dbg("LONG-TASK", "could not ensure task dir for listing:", e)
        return tasks
    }

    try {
        for (const entry of Deno.readDirSync(base)) {
            if (!entry.isDirectory) {
                continue
            }
            const task = readTask(entry.name)
            if (task) {
                tasks.push(task)
            }
        }
    } catch (e) {
        dbg("LONG-TASK", "listAllTasks scan failed:", e)
    }

    // sort by createdAt descending
    tasks.sort((a, b) => {
        const ta = a.createdAt || ""
        const tb = b.createdAt || ""
        if (ta > tb) { return -1 }
        if (ta < tb) { return 1 }
        return 0
    })

    return tasks
}

// ── Logging ────────────────────────────────────────────────────────

export function appendLog(taskId, logName, entry) {
    const dir = taskPath(taskId)
    const logFile = join(dir, `${logName}.jsonl`)
    try {
        const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n"
        Deno.writeTextFileSync(logFile, line, { append: true })
    } catch (e) {
        dbg("LONG-TASK", "appendLog failed for", taskId, logName, e)
    }
}
