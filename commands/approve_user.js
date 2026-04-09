export const tips = []

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { STATE_DIR, ACCESS_FILE } from '../lib/protocol.js'

const OTP_FILE = join(STATE_DIR, 'pending_otp.json')

export const commands = {
    approve_user: async (ctx, bot, state) => {
        if (ctx.chat?.type !== 'private') {
            return true
        }

        const text = ctx.message?.text ?? ''
        const match = text.match(/^\/approve_user\s+(\S+)/i)
        if (!match) {
            await ctx.reply('Usage: /approve_user one_time_password:<token>')
            return true
        }

        const submitted = match[1]

        // Expect format: one_time_password:<token>
        const otpMatch = submitted.match(/^one_time_password:(.+)$/)
        if (!otpMatch) {
            await ctx.reply('Invalid format. Expected: one_time_password:<token>')
            return true
        }
        const token = otpMatch[1]

        // Read the pending OTP
        let pending
        try {
            pending = JSON.parse(readFileSync(OTP_FILE, 'utf8'))
        } catch {
            await ctx.reply('No approval is pending. Run `cbg onboard` first.')
            return true
        }

        // Check token
        if (token !== pending.code) {
            await ctx.reply('Invalid token.')
            return true
        }

        // Success — add sender to allowlist and consume the OTP
        const senderId = String(ctx.from?.id)
        const access = state.loadAccess()
        if (!access.allowFrom.includes(senderId)) {
            access.allowFrom.push(senderId)
        }

        // Save access.json
        writeFileSync(ACCESS_FILE, JSON.stringify(access, null, 2) + '\n')

        // Delete the OTP file (one-time use)
        try { unlinkSync(OTP_FILE) } catch {}

        await ctx.reply(
            `Approved! Your user ID (${senderId}) has been added.\n\n` +
            'You can now send messages to Claude through this bot.'
        )
        return true
    },
}
