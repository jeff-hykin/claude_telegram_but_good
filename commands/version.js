// commands/version.js — Action-returning hot command.

import { versionedImport } from "../lib/version.js"
const { VERSION } = await versionedImport("../lib/version.js", import.meta)

export const tips = []

export const descriptions = {
    version: "Show the telegram plugin version",
}

export const commands = {
    version: (event, _core) => {
        if (event.chatType !== "private") {
            return { effects: [] }
        }
        return {
            effects: [
                {
                    type: "send_text_to_user",
                    chatId: event.chatId,
                    text: `telegram plugin v${VERSION}`,
                },
            ],
        }
    },
}
