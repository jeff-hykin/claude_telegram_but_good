// commands/ping.js — Action-returning hot command.

import { versionedImport } from "../lib/version.js"
const { sendEffect } = await versionedImport("../lib/pure/reply-to.js", import.meta)

export const tips = []

export const descriptions = {
    ping: "Check if the bot is alive",
}

export const commands = {
    ping: (event, _core) => ({
        effects: [sendEffect(event.replyTo, "pong")],
    }),
}
