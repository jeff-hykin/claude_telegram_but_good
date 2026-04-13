export const tips = []

// Hot commands live outside the cbgVersion import graph, so they use a
// random cache-buster per load. `saveAccess` is imported directly here
// (the state bridge only exposes read-side loadAccess); this lets the
// command atomically update access.json without going through an effect.
const { saveAccess } = await import(`../lib/access.js#${Math.random()}`)

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

        // Look up the OTP in the daemon's in-memory state (stashed by
        // `cbg onboard` or `cbg authorize` over IPC). No disk file.
        const pending = state.getPendingOtp(token)
        if (!pending) {
            await ctx.reply('No approval is pending for that token. Run `cbg onboard` or `cbg authorize` first.')
            return true
        }

        // Success — add sender to allowlist and consume the OTP
        const senderId = String(ctx.from?.id)
        const access = state.loadAccess()
        if (!access.allowFrom.includes(senderId)) {
            access.allowFrom.push(senderId)
        }

        // Save access.json atomically
        saveAccess(access)

        // Consume the OTP (single-use) from daemon state
        state.consumePendingOtp(token)

        await ctx.reply(
            `Approved! (Your user ID is ${senderId})\n\n` +
            'All your (new) claude cli sessions will be accessable to you here.\nUse /list to see them\nUse /new/new if you want to create one from here'
        )
        return true
    },
}
