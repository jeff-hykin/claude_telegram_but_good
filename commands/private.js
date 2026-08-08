// commands/private.js — Mark a command-center topic as private (excluded).
// A private topic writes {"private": true} into its config.json. External
// recorders (e.g. the jhist session-history sync) read this file and skip
// any Claude session belonging to a private topic, so personal topics never
// leave the machine.

import { versionedImport } from "../lib/version.js"
const { dbg } = await versionedImport("../lib/logging.js", import.meta)
const { paths } = await versionedImport("../lib/paths.js", import.meta)
const { replyToFromEvent, sendEffect } = await versionedImport("../lib/pure/reply-to.js", import.meta)
const { escapeMarkdown } = await versionedImport("../lib/pure/markdown.js", import.meta)

export const descriptions = {
    private: "Mark this topic private (excluded from jhist history sync)",
    unprivate: "Unmark this topic — allow it back into jhist history sync",
}

function topicNameFromEvent(event, core) {
    const threadId = event.threadId
    if (!threadId) {
        return null
    }
    const cc = core.chatState?.commandCenter ?? {}
    return cc.topicNames?.[String(threadId)] ?? null
}

function readTopicConfig(topicName) {
    try {
        return JSON.parse(Deno.readTextFileSync(paths.topicConfigFile(topicName)))
    } catch (e) {
        dbg("PRIVATE", "no/invalid topic config for", topicName, e)
        return {}
    }
}

function writeTopicConfig(topicName, config) {
    const file = paths.topicConfigFile(topicName)
    Deno.mkdirSync(paths.topicDir(topicName), { recursive: true })
    Deno.writeTextFileSync(file, JSON.stringify(config, null, 4) + "\n")
    return file
}

function setPrivate(event, core, makePrivate) {
    const replyTo = replyToFromEvent(event, "cmd/private")
    const topicName = topicNameFromEvent(event, core)
    if (!topicName) {
        return {
            effects: [sendEffect(replyTo, "This command only works inside a command center topic.")],
        }
    }

    const config = readTopicConfig(topicName)
    config.name = topicName
    config.private = makePrivate
    config.privateUpdatedAt = new Date().toISOString()

    let file
    try {
        file = writeTopicConfig(topicName, config)
    } catch (e) {
        dbg("PRIVATE", "failed writing topic config:", e)
        return {
            effects: [sendEffect(replyTo, `Failed to update topic config: ${escapeMarkdown(String(e))}`)],
        }
    }

    const text = makePrivate
        ? `🔒 *${escapeMarkdown(topicName)}* is now *private* — its Claude sessions will be excluded from jhist history sync.\n\n\`${file}\``
        : `🔓 *${escapeMarkdown(topicName)}* is no longer private — future sessions will sync to jhist again.\n\n\`${file}\``

    return {
        effects: [sendEffect(replyTo, text, { parse_mode: "Markdown" })],
    }
}

export const commands = {
    private: (event, core) => setPrivate(event, core, true),
    unprivate: (event, core) => setPrivate(event, core, false),
}
