/**
 * Download a Telegram file (e.g. a photo) into the local INBOX_DIR and
 * enqueue a follow-up event with the resulting filesystem path.
 *
 * This is the side-effectful mirror of the pure photo-attachment flow in
 * `lib/event-handlers/telegram-user.js`: the handler emits a
 * `download_telegram_file` effect describing what to fetch and what event
 * to re-emit once the file is local, and this module does the work.
 *
 * effect shape:
 *   {
 *     type: "download_telegram_file",
 *     fileId: string,
 *     fileUniqueId: string,
 *     followUpEvent: object, // re-enqueued with `imagePath` set on success
 *   }
 */

import { versionedImport } from "../version.js"
import { join } from "../../imports.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { paths } = await versionedImport("../paths.js", import.meta)
const { getBotToken } = await versionedImport("../config-manager.js", import.meta)

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

    if (!core.bot?.api) {
        dbg("TG-DL", "no bot.api available — cannot download")
        enqueueFollowUp(null)
        return
    }

    const token = getBotToken()
    if (!token) {
        dbg("TG-DL", "no bot token configured — cannot download")
        enqueueFollowUp(null)
        return
    }

    let file
    try {
        file = await core.bot.api.getFile(fileId)
    } catch (e) {
        dbg("TG-DL", `getFile failed for ${fileId}:`, e)
        enqueueFollowUp(null)
        return
    }

    if (!file?.file_path) {
        dbg("TG-DL", `getFile returned no file_path for ${fileId}`)
        enqueueFollowUp(null)
        return
    }

    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
    let buf
    try {
        const res = await fetch(url)
        if (!res.ok) {
            dbg("TG-DL", `fetch ${url} → HTTP ${res.status}`)
            enqueueFollowUp(null)
            return
        }
        buf = new Uint8Array(await res.arrayBuffer())
    } catch (e) {
        dbg("TG-DL", `fetch failed for ${fileId}:`, e)
        enqueueFollowUp(null)
        return
    }

    const ext = file.file_path.split(".").pop() || "bin"
    const uniq = fileUniqueId || fileId.slice(-12)
    const path = join(paths.INBOX_DIR, `${Date.now()}-${uniq}.${ext}`)

    try {
        Deno.mkdirSync(paths.INBOX_DIR, { recursive: true })
    } catch (e) {
        dbg("TG-DL", `mkdir ${paths.INBOX_DIR} failed:`, e)
        enqueueFollowUp(null)
        return
    }

    try {
        Deno.writeFileSync(path, buf)
    } catch (e) {
        dbg("TG-DL", `write ${path} failed:`, e)
        enqueueFollowUp(null)
        return
    }

    dbg("TG-DL", `downloaded ${fileId} → ${path} (${buf.byteLength} bytes)`)
    enqueueFollowUp(path)
}
