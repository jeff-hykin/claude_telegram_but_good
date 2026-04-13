/**
 * Download a chat-platform file reference (e.g. a Telegram file_id, a
 * Discord attachment URL) into the local INBOX_DIR and enqueue a
 * follow-up event with the resulting filesystem path.
 *
 * Goes through `core.bot.downloadFile(fileRef, localPath)` — the adapter
 * handles the platform-specific fetch. Extension preservation is done
 * via an optional `core.bot.getFileExtension(fileRef)` helper if the
 * adapter exposes one, otherwise the saved file gets a `.bin` extension.
 *
 * effect shape:
 *   {
 *     type: "download_telegram_file",
 *     fileId: string,            // platform-native file reference
 *     fileUniqueId: string,      // optional de-dup id used for the filename
 *     followUpEvent: object,     // re-enqueued with `imagePath` set
 *   }
 */

import { versionedImport } from "../version.js"
import { join } from "../../imports.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { paths } = await versionedImport("../paths.js", import.meta)

export async function downloadTelegramFile(effect, core) {
    const { fileId, fileUniqueId, followUpEvent } = effect

    if (!followUpEvent) {
        dbg("TG-DL", "download_telegram_file: missing followUpEvent, nothing to do")
        return
    }

    const enqueueFollowUp = (imagePath) => {
        try {
            core.enqueueEvent({
                ...followUpEvent,
                imagePath,
                ts: Date.now(),
            })
        } catch (e) {
            dbg("TG-DL", "failed to enqueue follow-up event:", e)
        }
    }

    if (!fileId) {
        dbg("TG-DL", "download_telegram_file: missing fileId")
        enqueueFollowUp(null)
        return
    }

    if (!core.bot) {
        dbg("TG-DL", "no bot available — cannot download")
        enqueueFollowUp(null)
        return
    }

    // Preserve the platform-side file extension if the adapter tells us
    // what it is. TelegramBot implements getFileExtension; others may
    // not — the fallback is the generic `.bin`.
    let ext = "bin"
    if (typeof core.bot.getFileExtension === "function") {
        const detected = await core.bot.getFileExtension(fileId)
        if (detected) { ext = detected }
    }

    const uniq = fileUniqueId || String(fileId).slice(-12)
    const path = join(paths.INBOX_DIR, `${Date.now()}-${uniq}.${ext}`)

    try {
        Deno.mkdirSync(paths.INBOX_DIR, { recursive: true })
    } catch (e) {
        dbg("TG-DL", `mkdir ${paths.INBOX_DIR} failed:`, e)
        enqueueFollowUp(null)
        return
    }

    const ok = await core.bot.downloadFile(fileId, path)
    if (!ok) {
        dbg("TG-DL", `downloadFile failed for ${fileId}`)
        enqueueFollowUp(null)
        return
    }

    dbg("TG-DL", `downloaded ${fileId} → ${path}`)
    enqueueFollowUp(path)
}
