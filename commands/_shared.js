// Shared mutable state for hot-reloadable commands.
// This file is imported by other command files.
// Note: on /reload, each file gets a fresh import, so this module
// also gets re-imported. To persist state across reloads, we attach
// to globalThis which survives module re-evaluation.

if (!globalThis.__tgCommandState) {
  globalThis.__tgCommandState = {
    titles: new Map(),     // sessionId -> title
    pausedSessions: new Set(),
    messageHistory: new Map(), // sessionId -> [{from, text}] (last 2)
  }
}

// Helper to record a message for the focused session
export function recordMessage(sessionId, from, text) {
  const history = globalThis.__tgCommandState.messageHistory
  if (!history.has(sessionId)) history.set(sessionId, [])
  const msgs = history.get(sessionId)
  msgs.push({ from, text: text.length > 200 ? text.slice(0, 200) + '...' : text })
  if (msgs.length > 2) msgs.shift()
}

export const shared = globalThis.__tgCommandState
