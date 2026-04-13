/**
 * Central effect dispatcher — the entry point of the side-effect layer.
 *
 * Handlers in lib/event-handlers/ return Actions describing side effects
 * they WANT to happen; main-event-processor.js calls `applyEffect()` for
 * each effect, and this module dispatches by `effect.type` to the right
 * sibling file under lib/effects/. Those siblings are the only place in
 * the codebase allowed to actually perform I/O (filesystem, Grammy,
 * dtach, subprocesses, ...).
 *
 * Every sibling is loaded via versionedImport so the effect layer itself
 * is hot-reloadable alongside the handlers — each effect dispatch picks
 * up the current cbgVersion.
 */

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)

export async function applyEffect(effect, core) {
    if (!effect || typeof effect !== "object" || !effect.type) {
        dbg("EFFECT", "invalid effect:", effect)
        return
    }
    switch (effect.type) {
        case "send_text_to_user": {
            const { sendTextMessageToUser } = await versionedImport("./telegram-outbound.js", import.meta)
            return await sendTextMessageToUser(effect, core)
        }
        case "send_file_to_user": {
            const { sendFileToUser } = await versionedImport("./telegram-outbound.js", import.meta)
            return await sendFileToUser(effect, core)
        }
        case "send_reaction": {
            const { sendReaction } = await versionedImport("./telegram-outbound.js", import.meta)
            return await sendReaction(effect, core)
        }
        case "edit_telegram_message": {
            const { editTelegramMessage } = await versionedImport("./telegram-outbound.js", import.meta)
            return await editTelegramMessage(effect, core)
        }
        case "answer_callback_query": {
            const { answerCallbackQuery } = await versionedImport("./telegram-outbound.js", import.meta)
            return await answerCallbackQuery(effect, core)
        }
        case "send_text_to_claude": {
            const { sendTextToClaude } = await versionedImport("./dtach-outbound.js", import.meta)
            return await sendTextToClaude(effect, core)
        }
        case "send_files_to_claude": {
            const { sendFilesToClaude } = await versionedImport("./dtach-outbound.js", import.meta)
            return await sendFilesToClaude(effect, core)
        }
        case "ipc_respond": {
            const { ipcRespond } = await versionedImport("./ipc-outbound.js", import.meta)
            return await ipcRespond(effect, core)
        }
        case "set_timer": {
            const { setTimer } = await versionedImport("./timers.js", import.meta)
            return setTimer(effect, core)
        }
        case "spawn_critic": {
            const { spawnCriticSubprocess } = await versionedImport("./critic-subprocess.js", import.meta)
            return await spawnCriticSubprocess(effect, core)
        }
        case "cold_append": {
            const { coldAppend } = await versionedImport("./cold-storage-effect.js", import.meta)
            return await coldAppend(effect, core)
        }
        case "deliver_channel_event": {
            const { deliverChannelEvent } = await versionedImport("./channel-event.js", import.meta)
            return await deliverChannelEvent(effect, core)
        }
        case "write_file": {
            const { writeFile } = await versionedImport("./filesystem.js", import.meta)
            return writeFile(effect, core)
        }
        case "bump_cbg_version": {
            const { bumpCbgVersion } = await versionedImport("./filesystem.js", import.meta)
            return bumpCbgVersion(effect, core)
        }
        case "run_hot_command": {
            const { runHotCommand } = await versionedImport("./hot-command-runner.js", import.meta)
            return await runHotCommand(effect, core)
        }
        case "reload_hot_commands": {
            const { reloadHotCommands } = await versionedImport("./hot-command-runner.js", import.meta)
            return await reloadHotCommands(effect, core)
        }
        case "download_telegram_file": {
            const { downloadTelegramFile } = await versionedImport("./telegram-download.js", import.meta)
            return await downloadTelegramFile(effect, core)
        }
        case "start_session_spinner": {
            const { startSessionSpinner } = await versionedImport("./session-spinner.js", import.meta)
            return await startSessionSpinner(effect, core)
        }
        case "append_tool_to_spinner": {
            const { appendToolToSpinner } = await versionedImport("./session-spinner.js", import.meta)
            return await appendToolToSpinner(effect, core)
        }
        case "clear_session_spinner": {
            const { clearSessionSpinner } = await versionedImport("./session-spinner.js", import.meta)
            return clearSessionSpinner(effect, core)
        }
        default: {
            dbg("EFFECT", "unknown effect type:", effect.type)
            return
        }
    }
}
