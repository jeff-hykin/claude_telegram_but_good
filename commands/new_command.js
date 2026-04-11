// Dynamic import with cache-busting: static imports of protocol.js would be
// cached from the first load and not pick up edits on hot-reload.
const { CUSTOM_COMMANDS_DIR } = await import(`../lib/protocol.js#${Math.random()}`)

export const tips = [
    "custom commands don't need to involve an agent, they're just JavaScript ( /new_command )",
    "the /new_command command lets you make your own",
    `custom telegram commands are saved in <code>${CUSTOM_COMMANDS_DIR}/</code> if you want to edit them`,
]

export const descriptions = {
  new_command: "Create a new custom Telegram command",
}

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
      `All Telegram messages must use parse_mode "HTML" (not Markdown). ` +
      `Use <i>, <b>, <code>, <pre> for formatting and escape user content with &amp; &lt; &gt;. ` +
      `Here is the user's description of what that new command should do:\n\n${arg}`
    )
    return true
  },
}
