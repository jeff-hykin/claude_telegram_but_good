/**
 * Hot-reloadable command loader.
 * Loads .js command files from commands/ and custom_commands/ directories.
 *
 * Uses Deno's dynamic import with cache-busting via temp file copies.
 */

import { join, toFileUrl } from "../imports.js"
import { dbg } from "./protocol.js"

const TEMP_CMD_DIR = join(Deno.env.get("TMPDIR") ?? "/tmp", "claude-telegram-hot-commands")

let hotCommands = new Map()
let allTips = []
let commandLoadCount = 0

export function getHotCommands() {
    return hotCommands
}

export function getAllTips() {
    return allTips
}

export function getRandomTip() {
    if (allTips.length === 0) return null
    return allTips[Math.floor(Math.random() * allTips.length)]
}

export async function loadCommandsFromDir(dir, newCommands, newTips, errors) {
    let entries
    try {
        entries = Array.from(Deno.readDirSync(dir)).filter(e => e.isFile && e.name.endsWith(".js"))
    } catch (err) {
        dbg("HOT", `readDirSync FAILED for ${dir}:`, err)
        return 0
    }

    const tmpSubdir = join(TEMP_CMD_DIR, `${commandLoadCount}_${Date.now()}`)
    Deno.mkdirSync(tmpSubdir, { recursive: true })
    for (const entry of entries) {
        try {
            Deno.writeTextFileSync(
                join(tmpSubdir, entry.name),
                Deno.readTextFileSync(join(dir, entry.name)),
            )
        } catch {
            // skip
        }
    }

    for (const entry of entries) {
        const tmpPath = join(tmpSubdir, entry.name)
        try {
            const mod = await import(toFileUrl(tmpPath).href)
            if (mod.commands && typeof mod.commands === "object") {
                for (const [name, handler] of Object.entries(mod.commands)) {
                    if (typeof handler === "function") {
                        newCommands.set(name, handler)
                    }
                }
            }
            if (Array.isArray(mod.tips)) {
                for (const tip of mod.tips) {
                    newTips.push(tip)
                }
            }
            dbg("HOT", `loaded ${entry.name}: ${Object.keys(mod.commands || {}).join(", ")}`)
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            dbg("HOT", `failed to load ${entry.name}: ${msg}`)
            errors.push(`${entry.name}: ${msg}`)
        }
    }
    try {
        Deno.removeSync(tmpSubdir, { recursive: true })
    } catch {
        // ignore
    }
    return entries.length
}

export async function loadCommands(builtinDir, customDir) {
    const newCommands = new Map()
    const newTips = []
    const errors = []
    commandLoadCount++

    const builtinFiles = await loadCommandsFromDir(builtinDir, newCommands, newTips, errors)
    const customFiles = await loadCommandsFromDir(customDir, newCommands, newTips, errors)

    hotCommands = newCommands
    allTips = newTips
    dbg("HOT", `loaded ${newCommands.size} commands from ${builtinFiles + customFiles} files`)
    return { loaded: newCommands.size, errors }
}
