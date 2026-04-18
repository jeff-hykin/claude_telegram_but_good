// commands/version.js — Action-returning hot command.

import { $ } from "../imports.js"
import { versionedImport } from "../lib/version.js"
const { VERSION } = await versionedImport("../lib/version.js", import.meta)
const { paths } = await versionedImport("../lib/paths.js", import.meta)

let gitTag = null
try {
    gitTag = (await $`git -C ${paths.LOCAL_REPO} describe --tags --abbrev=0`
        .timeout(3000).stderr("null").text()).trim()
} catch (e) {
    // Best-effort — fallback to hot-reload version if git isn't available.
}

export const tips = []

export const descriptions = {
    version: "Show the telegram plugin version",
}

export const commands = {
    version: (event, _core) => {
        const displayVersion = gitTag || `build ${VERSION}`
        return {
            effects: [
                {
                    type: "send_text_to_user",
                    chatId: event.chatId,
                    text: `cbg ${displayVersion}`,
                },
            ],
        }
    },
}
