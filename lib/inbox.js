/**
 * lib/inbox.js — persistent inbox system for inter-agent messaging.
 *
 * Every addressable entity (session, topic, CLI inbox) gets a directory
 * under $CBG_DIR/inboxes/<address>/ with a messages.jsonl file.
 *
 * Address conventions:
 *   - Session ID:  "QualifiedBandicoot" (PascalCase, matches session IDs)
 *   - Topic:       "topic:cbg" (prefixed with "topic:")
 *   - CLI inbox:   anything else (arbitrary string, e.g. "my_script_1")
 *
 * Message format (one JSON object per line):
 *   {
 *     ts: number,           // epoch ms
 *     from: {
 *       type: "telegram" | "session" | "cli",
 *       // telegram: { userId, chatId, threadId? }
 *       // session:  { sessionId, topicName? }
 *       // cli:      { inboxId }
 *     },
 *     text: string,
 *     meta?: object,
 *   }
 */

import { versionedImport } from "./version.js"

const { dbg } = await versionedImport("./logging.js", import.meta)
const { paths } = await versionedImport("./paths.js", import.meta)

/**
 * Append a message to an inbox's messages.jsonl.
 * Creates the inbox directory if it doesn't exist.
 *
 * @param {string} address — inbox address (session ID, "topic:name", or arbitrary)
 * @param {object} message — { ts, from, text, meta? }
 */
export async function appendInboxMessage(address, message) {
    const filePath = paths.inboxMessagesFile(address)
    const dir = paths.inboxDir(address)
    try {
        await Deno.mkdir(dir, { recursive: true })
        const line = JSON.stringify(message) + "\n"
        const file = await Deno.open(filePath, { write: true, create: true, append: true })
        try {
            await file.write(new TextEncoder().encode(line))
        } finally {
            file.close()
        }
    } catch (e) {
        dbg("INBOX", `failed to write to ${address}:`, e)
    }
}

/**
 * Read the latest (last) message from an inbox.
 * Returns the parsed object, or null if the inbox is empty/missing.
 *
 * @param {string} address
 * @returns {object|null}
 */
export function readLatestInboxMessage(address) {
    const filePath = paths.inboxMessagesFile(address)
    try {
        const content = Deno.readTextFileSync(filePath)
        const lines = content.trimEnd().split("\n")
        const last = lines[lines.length - 1]
        if (!last) { return null }
        return JSON.parse(last)
    } catch (e) {
        if (e instanceof Deno.errors.NotFound) { return null }
        dbg("INBOX", `failed to read latest from ${address}:`, e)
        return null
    }
}

/**
 * Read the last N messages from an inbox.
 *
 * @param {string} address
 * @param {number} count
 * @returns {object[]}
 */
export function readInboxMessages(address, count = 10) {
    const filePath = paths.inboxMessagesFile(address)
    try {
        const content = Deno.readTextFileSync(filePath)
        const lines = content.trimEnd().split("\n").filter(Boolean)
        const slice = lines.slice(-count)
        return slice.map(line => {
            try { return JSON.parse(line) }
            catch { return null }
        }).filter(Boolean)
    } catch (e) {
        if (e instanceof Deno.errors.NotFound) { return [] }
        dbg("INBOX", `failed to read from ${address}:`, e)
        return []
    }
}

/**
 * Check if an inbox directory exists.
 *
 * @param {string} address
 * @returns {boolean}
 */
export function inboxExists(address) {
    try {
        Deno.statSync(paths.inboxDir(address))
        return true
    } catch {
        return false
    }
}

/**
 * Build a "topic:name" inbox address from a topic name.
 */
export function topicInboxAddress(topicName) {
    return `topic:${topicName}`
}
