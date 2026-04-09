/**
 * Hot-reloadable command loader.
 * Loads .js command files from commands/ and custom_commands/ directories.
 *
 * Uses Deno's dynamic import with cache-busting via URL fragments.
 */

import { join, toFileUrl } from "../imports.js"
import { dbg } from "./protocol.js"

let hotCommands = new Map()
let allTips = []

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

    for (const entry of entries) {
        const filePath = join(dir, entry.name)
        try {
            // Cache-bust with a fragment so Deno re-evaluates the module on hot-reload
            const mod = await import(`${toFileUrl(filePath).href}#${Math.random()}`)
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
    return entries.length
}

export async function loadCommands(builtinDir, customDir) {
    const newCommands = new Map()
    const newTips = []
    const errors = []

    const builtinFiles = await loadCommandsFromDir(builtinDir, newCommands, newTips, errors)
    const customFiles = await loadCommandsFromDir(customDir, newCommands, newTips, errors)

    hotCommands = newCommands
    allTips = newTips
    dbg("HOT", `loaded ${newCommands.size} commands from ${builtinFiles + customFiles} files`)
    return { loaded: newCommands.size, errors }
}
