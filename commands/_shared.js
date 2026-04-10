// Shared mutable state for hot-reloadable commands.
// This file is imported by other command files.
// Note: on /reload, each file gets a fresh import, so this module
// also gets re-imported. To persist state across reloads, we attach
// to globalThis which survives module re-evaluation.

if (!globalThis.__tgCommandState) {
  globalThis.__tgCommandState = {
    titles: new Map(),     // sessionId -> title
  }
}

export const shared = globalThis.__tgCommandState
