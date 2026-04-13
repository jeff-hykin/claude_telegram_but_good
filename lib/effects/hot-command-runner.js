/**
 * Hot-reloadable command runner.
 *
 * This file is the EFFECT DISPATCHER half of the hot-command subsystem:
 * it implements `run_hot_command` and `reload_hot_commands` effects and
 * handles the runtime side of command execution (Grammy ctx, error UI,
 * error-record stashing). The REGISTRY that loads the command files and
 * holds them in a Map lives in `lib/hot-commands.js`. This file is under
 * `lib/effects/` because it's in the side-effect layer that
 * `apply-effect.js` dispatches to; the registry lives at `lib/` because
 * it's stateful, consumed by the effect layer rather than part of it.
 *
 * Bridges the legacy hot-command API (where handlers take `(ctx, bot,
 * state)` and call `ctx.reply(...)` / `bot.api.*` directly) to the new
 * event-loop architecture.
 *
 * Handlers in the new architecture are supposed to be pure (return
 * Actions, never mutate state, never do side effects). The hot commands
 * in `commands/*.js` predate this rule and use the Grammy ctx/bot APIs
 * imperatively. Rewriting all 18 commands is a separate phase; for now
 * we run them as-is via this bridging effect.
 *
 * Effect shape: `{ type: "run_hot_command", name, ctx, state }`
 *
 * IMPORTANT: commands bypass the event loop's single-writer guarantee.
 * They can call `ctx.reply`, `bot.api.*`, and mutate `state` imperatively.
 * This is a pragmatic concession — when hot commands are ported to
 * return Actions we'll retire this runner.
 */

import { versionedImport } from "../version.js"
import { InlineKeyboard } from "../../imports.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { randomHex } = await versionedImport("../pure/ids.js", import.meta)
const { getHotCommands, loadCommands } = await versionedImport("../hot-commands.js", import.meta)

export async function runHotCommand(effect, core) {
    const { name, ctx, state } = effect
    if (!name) {
        dbg("HOT-CMD", "run_hot_command: missing name")
        return
    }
    if (!ctx) {
        dbg("HOT-CMD", `run_hot_command: missing ctx for ${name}`)
        return
    }

    const handler = getHotCommands().get(name)
    if (typeof handler !== "function") {
        dbg("HOT-CMD", `unknown hot command: ${name}`)
        try {
            await ctx.reply(`Unknown command: /${name}. Use /help to see available commands.`)
        } catch (e) {
            dbg("HOT-CMD", "reply after unknown command failed:", e)
        }
        return
    }

    try {
        const handled = await handler(ctx, core.bot, state)
        dbg("HOT-CMD", `${name} completed (handled=${handled})`)
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const stack = err instanceof Error ? (err.stack ?? "") : ""
        dbg("HOT-CMD", `command ${name} threw:`, err)
        // Stash the failure so the "Ask Claude to fix" inline button has
        // somewhere to look the details up. NOTE: this is a direct
        // mutation of core.chatState — a bridging concession because
        // hot commands live outside the pure-handler model. The pure
        // handlers go through state patches and mergeSessionData; this
        // file is allowed to write directly the same way it's allowed
        // to call ctx.reply. The callback handler later removes this
        // entry via a normal state patch.
        const errorId = randomHex(4)
        const originalText = ctx.message?.text ?? ""
        if (!core.chatState.commandErrors) {
            core.chatState = { ...core.chatState, commandErrors: {} }
        }
        core.chatState.commandErrors[errorId] = {
            cmdName: name,
            error: msg,
            stack,
            originalText,
            createdAt: Date.now(),
        }
        try {
            const keyboard = new InlineKeyboard().text(
                "🔧 Ask Claude to fix",
                `cmderr:fix:${errorId}`,
            )
            await ctx.reply(`⚠️ /${name} failed: ${msg}`, { reply_markup: keyboard })
        } catch (e) {
            dbg("HOT-CMD", "reply after command error failed:", e)
        }
    }
}

/**
 * Effect shape: `{ type: "reload_hot_commands", builtinDir }`
 * Reloads every command file fresh. Called by the `reload` MCP tool
 * and after `new_command` writes a new custom command.
 */
export async function reloadHotCommands(effect, core) {
    const builtinDir = effect.builtinDir ?? core.commandsDir
    if (!builtinDir) {
        dbg("HOT-CMD", "reload_hot_commands: no builtinDir")
        return
    }
    try {
        const { loaded, errors } = await loadCommands(builtinDir)
        dbg("HOT-CMD", `reloaded: ${loaded} commands, ${errors.length} errors`)
    } catch (e) {
        dbg("HOT-CMD", "reload failed:", e)
    }
}
