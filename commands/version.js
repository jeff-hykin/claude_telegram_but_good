export const commands = {
  version: async (ctx, bot, state) => {
    if (ctx.chat?.type !== 'private') return true
    await ctx.reply(`telegram plugin v${state.PLUGIN_VERSION}`)
    return true
  },
}
