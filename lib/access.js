/**
 * Access control: pairing, allowlists, group policies.
 *
 * paths / dbg are loaded via versionedImport so this module shares the
 * single versioned instance with every other reloadable file — a bare
 * `import { paths }` would produce a second independent singleton that
 * test/runtime mutations on one wouldn't see on the other.
 */

import { versionedImport } from "./version.js"
import { randomHex } from "./pure/ids.js"

const { paths } = await versionedImport("./paths.js", import.meta)
const { dbg } = await versionedImport("./logging.js", import.meta)

export function defaultAccess() {
    return {
        dmPolicy: "pairing",
        allowFrom: [],
        groups: {},
        pending: {},
        commandCenterChatId: null,
    }
}

export function readAccessFile() {
    try {
        const raw = Deno.readTextFileSync(paths.ACCESS_FILE)
        const parsed = JSON.parse(raw)
        return {
            dmPolicy: parsed.dmPolicy ?? "pairing",
            allowFrom: parsed.allowFrom ?? [],
            groups: parsed.groups ?? {},
            pending: parsed.pending ?? {},
            mentionPatterns: parsed.mentionPatterns,
            ackReaction: parsed.ackReaction,
            replyToMode: parsed.replyToMode,
            textChunkLimit: parsed.textChunkLimit,
            chunkMode: parsed.chunkMode,
            commandCenterChatId: parsed.commandCenterChatId ?? null,
        }
    } catch (err) {
        if (err instanceof Deno.errors.NotFound) {
            return defaultAccess()
        }
        try {
            Deno.renameSync(paths.ACCESS_FILE, `${paths.ACCESS_FILE}.corrupt-${Date.now()}`)
        } catch {
            // ignore
        }
        Deno.stderr.writeSync(new TextEncoder().encode(
            "telegram channel: access.json is corrupt, moved aside. Starting fresh.\n"
        ))
        return defaultAccess()
    }
}

export function saveAccess(a) {
    Deno.mkdirSync(paths.STATE_DIR, { recursive: true })
    const tmp = paths.ACCESS_FILE + ".tmp"
    Deno.writeTextFileSync(tmp, JSON.stringify(a, null, 2) + "\n")
    Deno.renameSync(tmp, paths.ACCESS_FILE)
}

export function pruneExpired(a) {
    const now = Date.now()
    let changed = false
    for (const [code, p] of Object.entries(a.pending)) {
        if (p.expiresAt < now) {
            delete a.pending[code]
            changed = true
        }
    }
    return changed
}

export function loadAccess(staticAccess = null) {
    return staticAccess ?? readAccessFile()
}

export function assertAllowedChat(chat_id, staticAccess = null) {
    const access = loadAccess(staticAccess)
    if (access.allowFrom.includes(chat_id)) {
        return
    }
    if (chat_id in access.groups) {
        return
    }
    throw new Error(`chat ${chat_id} is not allowlisted — add via /telegram:access`)
}

export function gate(ctx, botUsername, staticAccess = null) {
    const access = loadAccess(staticAccess)
    dbg("GATE", "access:", JSON.stringify(access))
    const pruned = pruneExpired(access)
    if (pruned && !staticAccess) {
        saveAccess(access)
    }

    if (access.dmPolicy === "disabled") {
        dbg("GATE", "DROPPED: dmPolicy=disabled")
        return { action: "drop" }
    }

    const from = ctx.from
    if (!from) {
        dbg("GATE", "DROPPED: no from")
        return { action: "drop" }
    }
    const senderId = String(from.id)
    const chatType = ctx.chat?.type
    dbg("GATE", "senderId:", senderId, "chatType:", chatType, "allowFrom:", access.allowFrom)

    if (chatType === "private") {
        if (access.allowFrom.includes(senderId)) {
            dbg("GATE", "DELIVER: sender in allowFrom")
            return { action: "deliver", access }
        }
        if (access.dmPolicy === "allowlist") {
            dbg("GATE", "DROPPED: policy=allowlist, sender not in list")
            return { action: "drop" }
        }

        for (const [code, p] of Object.entries(access.pending)) {
            if (p.senderId === senderId) {
                if ((p.replies ?? 1) >= 2) {
                    return { action: "drop" }
                }
                p.replies = (p.replies ?? 1) + 1
                saveAccess(access)
                return { action: "pair", code, isResend: true }
            }
        }
        if (Object.keys(access.pending).length >= 3) {
            return { action: "drop" }
        }

        const code = randomHex(3)
        const now = Date.now()
        access.pending[code] = {
            senderId,
            chatId: String(ctx.chat.id),
            createdAt: now,
            expiresAt: now + 60 * 60 * 1000,
            replies: 1,
        }
        saveAccess(access)
        return { action: "pair", code, isResend: false }
    }

    if (chatType === "group" || chatType === "supergroup") {
        const groupId = String(ctx.chat.id)
        if (groupId === String(access.commandCenterChatId ?? "")) {
            return { action: "deliver", access, isCommandCenter: true }
        }
        const policy = access.groups[groupId]
        if (!policy) {
            return { action: "drop" }
        }
        const groupAllowFrom = policy.allowFrom ?? []
        const requireMention = policy.requireMention ?? true
        if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) {
            return { action: "drop" }
        }
        if (requireMention && !isMentioned(ctx, botUsername, access.mentionPatterns)) {
            return { action: "drop" }
        }
        return { action: "deliver", access }
    }

    return { action: "drop" }
}

export function isMentioned(ctx, botUsername, extraPatterns) {
    const entities = ctx.message?.entities ?? ctx.message?.caption_entities ?? []
    const text = ctx.message?.text ?? ctx.message?.caption ?? ""
    for (const e of entities) {
        if (e.type === "mention") {
            const mentioned = text.slice(e.offset, e.offset + e.length)
            if (mentioned.toLowerCase() === `@${botUsername}`.toLowerCase()) {
                return true
            }
        }
        if (e.type === "text_mention" && e.user?.is_bot && e.user.username === botUsername) {
            return true
        }
    }
    if (ctx.message?.reply_to_message?.from?.username === botUsername) {
        return true
    }
    for (const pat of extraPatterns ?? []) {
        try {
            if (new RegExp(pat, "i").test(text)) {
                return true
            }
        } catch {
            // skip invalid regex
        }
    }
    return false
}

export function checkApprovals(bot) {
    let files
    try {
        files = Array.from(Deno.readDirSync(paths.APPROVED_DIR)).map(e => e.name)
    } catch {
        return
    }
    if (files.length === 0) {
        return
    }

    for (const senderId of files) {
        const file = `${paths.APPROVED_DIR}/${senderId}`
        void bot.sendText(senderId, "Paired! Say hi to Claude.", { format: "plain" }).then(
            () => {
                try { Deno.removeSync(file) } catch (e) { dbg("ACCESS", "remove approval file:", e) }
            },
            (err) => {
                Deno.stderr.writeSync(new TextEncoder().encode(
                    `telegram channel: failed to send approval confirm: ${err}\n`
                ))
                try { Deno.removeSync(file) } catch (e) { dbg("ACCESS", "remove approval file:", e) }
            },
        )
    }
}
