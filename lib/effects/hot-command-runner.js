/**
 * Hot-command reload effect.
 *
 * Historically this module also exported a `runHotCommand` runner
 * that bridged the legacy `(ctx, bot, state)` API to the event loop.
 * Commands now return Actions directly and the dispatcher in
 * `lib/event-handlers/chat-user.js` (`dispatchHotCommand`) calls
 * the handler inline — so the only responsibility left in this file
 * is the `reload_hot_commands` effect, which re-walks the
 * commands/ + custom_commands/ dirs and replaces the in-memory
 * registry.
 *
 * Effect shape: `{ type: "reload_hot_commands", builtinDir }`
 * Called by the `reload` MCP tool and after `new_command` writes a
 * new custom command.
 */

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { loadCommands, getCommandDescriptions } = await versionedImport("../hot-commands.js", import.meta)

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
        return
    }
    // Re-publish the command menu so newly-added custom commands show
    // up in the bot's slash-command autocomplete without a daemon
    // restart. `setCommands` is a no-op for adapters that don't
    // implement it (the default Bot base class returns false), and a
    // replacement-style call — whatever the registry has now IS the
    // menu.
    try {
        if (core?.bot?.setCommands) {
            const entries = [...getCommandDescriptions().entries()].map(
                ([command, description]) => ({ command, description }),
            )
            if (entries.length > 0) {
                await core.bot.setCommands(entries)
                dbg("HOT-CMD", `republished ${entries.length} slash commands`)
            }
        }
    } catch (e) {
        dbg("HOT-CMD", "setCommands after reload failed:", e)
    }
}
