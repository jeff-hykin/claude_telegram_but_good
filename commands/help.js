export const commands = {
  help: async (ctx, bot, state) => {
    if (ctx.chat?.type !== 'private') return true
    await ctx.reply(
      `Messages you send here route to a paired Claude Code session. ` +
      `Text and photos are forwarded; replies and reactions come back.\n\n` +
      `/start — pairing instructions\n` +
      `/status — check your pairing state\n` +
      `/list — show connected sessions (tap an ID to switch)\n` +
      `/title <name> — label the focused session\n` +
      `/spawn_d — launch a new Claude Code session\n` +
      `/reload — hot-reload command handlers\n` +
      `/ping — test if the bot is alive`
    )
    return true
  },
}
