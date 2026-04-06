export const commands = {
  title: async (ctx, bot, state) => {
    if (ctx.chat?.type !== 'private') return true
    const access = state.loadAccess()
    const senderId = String(ctx.from?.id)
    if (!access.allowFrom.includes(senderId)) return true

    if (!state.isPrimary) {
      await ctx.reply('Only available on the primary.')
      return true
    }

    // Extract title from /title <text>
    const text = ctx.message?.text || ''
    const title = text.replace(/^\/title\s*/i, '').trim()

    if (!title) {
      // No argument — set title on the focused session via MCP tool
      await ctx.reply('Usage: /title <text>\nSets the title on the focused session.')
      return true
    }

    const ok = state.setSessionTitle(state.focusedSessionId, title)
    if (ok) {
      await ctx.reply(`Title set for ${state.focusedSessionId}: ${title}`)
    } else {
      await ctx.reply('Failed to set title — session not found.')
    }
    return true
  },
}
