/**
 * Hot-reloadable command loader.
 * Loads .js command files from commands/ and custom_commands/ directories.
 */

import { readdirSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import { pathToFileURL } from 'url'
import type { Bot, Context } from 'grammy'
import { dbgSync as dbg } from './protocol.ts'

export type CommandState = Record<string, unknown>
export type CommandHandler = (ctx: Context, bot: Bot, state: CommandState) => Promise<boolean | void>

const TEMP_CMD_DIR = join(tmpdir(), 'claude-telegram-hot-commands')

let hotCommands = new Map<string, CommandHandler>()
let commandLoadCount = 0

export function getHotCommands(): Map<string, CommandHandler> {
  return hotCommands
}

export async function loadCommandsFromDir(dir: string, newCommands: Map<string, CommandHandler>, errors: string[]): Promise<number> {
  let files: string[]
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.js'))
  } catch { return 0 }

  const tmpSubdir = join(TEMP_CMD_DIR, `${commandLoadCount}_${Date.now()}`)
  mkdirSync(tmpSubdir, { recursive: true })
  for (const file of files) {
    try { writeFileSync(join(tmpSubdir, file), readFileSync(join(dir, file), 'utf8')) } catch {}
  }

  for (const file of files) {
    const tmpPath = join(tmpSubdir, file)
    try {
      const mod = await import(pathToFileURL(tmpPath).href)
      if (mod.commands && typeof mod.commands === 'object') {
        for (const [name, handler] of Object.entries(mod.commands)) {
          if (typeof handler === 'function') {
            newCommands.set(name, handler as CommandHandler)
          }
        }
      }
      dbg('HOT', `loaded ${file}: ${Object.keys(mod.commands || {}).join(', ')}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      dbg('HOT', `failed to load ${file}: ${msg}`)
      errors.push(`${file}: ${msg}`)
    }
  }
  try { rmSync(tmpSubdir, { recursive: true }) } catch {}
  return files.length
}

export async function loadCommands(builtinDir: string, customDir: string): Promise<{ loaded: number; errors: string[] }> {
  const newCommands = new Map<string, CommandHandler>()
  const errors: string[] = []
  commandLoadCount++

  const builtinFiles = await loadCommandsFromDir(builtinDir, newCommands, errors)
  const customFiles = await loadCommandsFromDir(customDir, newCommands, errors)

  hotCommands = newCommands
  dbg('HOT', `loaded ${newCommands.size} commands from ${builtinFiles + customFiles} files`)
  return { loaded: newCommands.size, errors }
}
