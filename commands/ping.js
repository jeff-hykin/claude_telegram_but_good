// commands/ping.js — Action-returning hot command.
//
// Contract (since the commands-port):
//     commands[name]: async (event, core) => Action
//
// where `event` is the originating `chat_user_message` event and
// `core` is the shell kernel (read-only access to state + enqueueEvent).
// Commands never call `ctx.reply` or mutate state directly; they
// describe intent via the same `{ stateChanges, effects, followUpEvents }`
// shape event-handlers use.

import { versionedImport } from "../lib/version.js"
const { replyToFromEvent, sendEffect } = await versionedImport("../lib/pure/reply-to.js", import.meta)

export const tips = []

export const descriptions = {
    ping: "Check if the bot is alive",
}

export const commands = {
    ping: (event, _core) => {
        const replyTo = replyToFromEvent(event, "cmd/ping")
        return {
            effects: [sendEffect(replyTo, "pong")],
        }
    },
}
