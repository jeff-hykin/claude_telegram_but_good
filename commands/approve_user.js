// commands/approve_user.js — Action-returning hot command.
//
// Adds the sender to access.allowFrom if the OTP they sent matches a
// pending entry in chatState.pendingOtps. The file-write for
// access.json stays inline (saveAccess is idempotent and has no
// effect-layer helper); the OTP consume flows through stateChanges so
// pendingOtps is updated through the normal merge pathway.

import { versionedImport } from "../lib/version.js"
const { loadAccess, saveAccess } = await versionedImport("../lib/access.js", import.meta)
const { makeReplyTo, sendEffect } = await versionedImport("../lib/pure/reply-to.js", import.meta)

export const tips = []

export const descriptions = {
    approve_user: "Redeem a one-time pairing token to join the allowlist",
}

export const commands = {
    approve_user: (event, core) => {
        if (event.chatType !== "private") { return { effects: [] } }

        const replyTo = makeReplyTo(event, "cmd/approve_user")
        const text = event.text ?? ""
        const match = text.match(/^\/approve_user\s+(\S+)/i)
        if (!match) {
            return { effects: [sendEffect(replyTo, "Usage: /approve_user one_time_password:<token>")] }
        }

        const submitted = match[1]
        const otpMatch = submitted.match(/^one_time_password:(.+)$/)
        if (!otpMatch) {
            return { effects: [sendEffect(replyTo, "Invalid format. Expected: one_time_password:<token>")] }
        }
        const token = otpMatch[1]

        const pending = core.chatState?.pendingOtps?.[token]
        if (!pending) {
            return { effects: [sendEffect(replyTo, "No approval is pending for that token. Run `cbg onboard` or `cbg authorize` first.")] }
        }

        const senderId = String(event.userId ?? "")
        const access = loadAccess()
        if (!access.allowFrom.includes(senderId)) {
            access.allowFrom.push(senderId)
        }
        // saveAccess is the only disk write; no effect-layer helper
        // exists for access.json. Keep inline.
        saveAccess(access)

        return {
            stateChanges: {
                chatState: {
                    pendingOtps: { [token]: undefined },
                },
            },
            effects: [
                sendEffect(replyTo,
                    `Approved! (Your user ID is ${senderId})\n\n` +
                    "All your (new) claude cli sessions will be accessable to you here.\nUse /list to see them\nUse /new if you want to create one from here",
                ),
            ],
        }
    },
}
