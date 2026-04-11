export const tips = []

export const descriptions = {
  start: "Welcome and pairing instructions",
}

export const commands = {
  start: async (ctx, bot, state) => {
    if (ctx.chat?.type !== 'private') return true
    const access = state.loadAccess()
    if (access.dmPolicy === 'disabled') {
      await ctx.reply(`This bot isn't accepting new connections.`)
      return true
    }
    const userId = ctx.from?.id ?? 'unknown'
    await ctx.reply(
      `This bot bridges Telegram to a Claude Code session.\n\n` +
      `Your Telegram user ID: ${userId}\n\n` +
      `To pair:\n` +
      `1. DM me anything — you'll get a 6-char code\n` +
      `2. In Claude Code: /telegram:access pair <code>\n\n` +
      `After that, DMs here reach that session.`
    )
    return true
  },
}
