export const commands = {
  new_command: async (ctx, bot, state) => {
    if (ctx.chat?.type !== 'private') return true
    const access = state.loadAccess()
    const senderId = String(ctx.from?.id)
    if (!access.allowFrom.includes(senderId)) return true

    const text = ctx.message?.text || ''
    const arg = text.replace(/^\/new_command\s*/, '').trim()

    if (!arg) {
      await ctx.reply('Usage: /new_command <description of what the command should do>')
      return true
    }

    state.letClaudeHandle(ctx,
      `Please make a new telegram command by using the new_command MCP tool you have access to. ` +
      `Here is the user's description of what that new command should do:\n\n${arg}`
    )
    return true
  },
}
