export const tips = []

export const descriptions = {
  ping: "Check if the bot is alive",
}

export const commands = {
  ping: async (ctx, bot, state) => {
    await ctx.reply('pong')
    return true
  },
}
