// Dynamic import with cache-busting so hot-reload picks up edits to _shared.js
const { recordMessage } = await import(`./_shared.js#${Math.random()}`)

export const tips = []

export const commands = {
  // Called on every inbound text message (before command dispatch)
  __onMessage: async (ctx, bot, state) => {
    const user = ctx.from?.username || ctx.from?.first_name || 'user'
    const text = ctx.message?.text || ''
    // Don't record bot commands for history
    if (!text.startsWith('/')) {
      recordMessage(state.focusedSessionId, user, text)
    }
  },

  // Called on every outbound reply from Claude
  __onReply: async (ctx, bot, state) => {
    // ctx here is { text, chat_id } — not a real grammy Context
    const text = ctx.text || ''
    recordMessage(state.focusedSessionId, 'claude', text)
  },
}
