import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const STATE_DIR = join(homedir(), '.claude', 'channels', 'telegram')
const PASSCODE_FILE = join(STATE_DIR, 'pending_passcode.json')

export const commands = {
    passcode: async (ctx, bot, state) => {
        if (ctx.chat?.type !== 'private') {
            return true
        }

        const text = ctx.message?.text ?? ''
        const match = text.match(/^\/passcode\s+(\S+)/i)
        if (!match) {
            await ctx.reply('Usage: /passcode <code>')
            return true
        }

        const submitted = match[1]

        // Read the pending passcode
        let pending
        try {
            pending = JSON.parse(readFileSync(PASSCODE_FILE, 'utf8'))
        } catch {
            await ctx.reply('No passcode is pending. Run `cbg onboard` first.')
            return true
        }

        // Check expiry
        if (pending.expiresAt && Date.now() > pending.expiresAt) {
            try { unlinkSync(PASSCODE_FILE) } catch {}
            await ctx.reply('Passcode expired. Run `cbg onboard` again.')
            return true
        }

        // Check code
        if (submitted !== pending.code) {
            await ctx.reply('Invalid passcode.')
            return true
        }

        // Success — add sender to allowlist and consume the passcode
        const senderId = String(ctx.from?.id)
        const access = state.loadAccess()
        if (!access.allowFrom.includes(senderId)) {
            access.allowFrom.push(senderId)
        }

        // Save access.json
        const accessFile = join(STATE_DIR, 'access.json')
        writeFileSync(accessFile, JSON.stringify(access, null, 2) + '\n')

        // Delete the passcode file (one-time use)
        try { unlinkSync(PASSCODE_FILE) } catch {}

        await ctx.reply(
            `Paired! Your user ID (${senderId}) has been added.\n\n` +
            'You can now send messages to Claude through this bot.'
        )
        return true
    },
}
