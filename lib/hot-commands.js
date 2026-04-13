/**
 * Hot-reloadable command loader.
 *
 * This file is the REGISTRY half of the hot-command subsystem: it loads
 * command files from disk and holds them in a module-level Map. The
 * EFFECT DISPATCHER that actually invokes a command (handling its
 * errors, rendering the "Ask Claude to fix" button on failure, etc.)
 * lives in `lib/effects/hot-command-runner.js`. The split is deliberate
 * — this file is pure registry state, the runner is the side-effect
 * layer that consumes it.
 *
 * Loads `.js` command files from two directories:
 *   - builtin commands at <repo>/commands/ (CBG-shipped)
 *   - user custom commands at CUSTOM_COMMANDS_DIR (~/.claude/telegram/custom_commands/)
 *
 * Each file exports:
 *   - `commands`: { name: async (ctx, bot, state) => bool }
 *   - `tips`: string[]  (optional)
 *   - `descriptions`: { name: string }  (optional)
 *
 * Cache-busting uses a RANDOM fragment (NOT cbgVersion) because user
 * commands live outside CBG's edit cycle — they change independently
 * and we want every call to see the latest on-disk version.
 *
 * This module holds module-level state (hotCommands Map). When the
 * module is hot-reloaded via versionedImport?v=N, a new state Map is
 * created — stale commands from version N-1 fall out of scope with
 * the old module instance.
 */

import { versionedImport } from "./version.js"
import { join, toFileUrl } from "../imports.js"

const { dbg } = await versionedImport("./logging.js", import.meta)
const { paths } = await versionedImport("./paths.js", import.meta)

let hotCommands = new Map()
let allTips = []
let allDescriptions = new Map()

export function getHotCommands() {
    return hotCommands
}

export function getAllTips() {
    return allTips
}

export function getCommandDescriptions() {
    return allDescriptions
}

export function getRandomTip() {
    if (allTips.length === 0) {
        return null
    }
    return allTips[Math.floor(Math.random() * allTips.length)]
}

async function loadCommandsFromDir(dir, newCommands, newTips, newDescriptions, errors) {
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
            // Random fragment forces Deno to re-evaluate the module even
            // if the URL has been imported before in this process.
            const url = `${toFileUrl(filePath).href}#${Math.random()}`
            const mod = await import(url)
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
            if (mod.descriptions && typeof mod.descriptions === "object") {
                for (const [name, desc] of Object.entries(mod.descriptions)) {
                    if (typeof desc === "string" && desc.length > 0) {
                        newDescriptions.set(name, desc)
                    }
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

/**
 * Walk both command directories and replace the active command set.
 *
 * @param {string} builtinDir — absolute path to the builtin commands dir
 *   (usually join(paths.LOCAL_REPO, "commands"))
 * @returns {Promise<{ loaded: number, errors: string[] }>}
 */
export async function loadCommands(builtinDir) {
    const newCommands = new Map()
    const newTips = []
    const newDescriptions = new Map()
    const errors = []

    const builtinFiles = await loadCommandsFromDir(builtinDir, newCommands, newTips, newDescriptions, errors)
    const customFiles = await loadCommandsFromDir(paths.CUSTOM_COMMANDS_DIR, newCommands, newTips, newDescriptions, errors)

    hotCommands = newCommands
    allTips = newTips
    allDescriptions = newDescriptions
    dbg("HOT", `loaded ${newCommands.size} commands from ${builtinFiles + customFiles} files`)
    return { loaded: newCommands.size, errors }
}
