export const commands = {
  ping: async (ctx, bot, state) => {
    await ctx.reply('pong')
    return true
  },
}
