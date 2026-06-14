---
name: self_clear
description: Wipe your OWN conversation context by running /clear on yourself, then relaunch as a fresh successor on the remaining work. Use only when your context is badly polluted and a clean restart beats compacting. Only works inside a cbg-managed claude session.
allowed-tools: Bash(cbg self-input:*)
---

# self_clear — clear your own context and continue as a successor

This types `/clear` into your own session, which **ERASES your entire
conversation** — unlike `/compact`, nothing is summarized or kept. Use it
only when your context is so polluted (rationalizing, excuse-making, long
dead ends) that a clean restart is better than compacting.

## CRITICAL: your future self will remember NOTHING

After `/clear`, you start blank. So you MUST hand off in writing first.

1. **Write the handoff to a durable file.** Put the remaining work, key
   decisions, and where to look into a file the successor will read — e.g.
   append to `progress.md` in your task directory (long-task workers already
   have one), or create a `HANDOFF.md`. List the concrete remaining items
   explicitly.

2. **Clear and relaunch as a successor in ONE command** (substitute the real
   handoff path and remaining items):

   ```
   cbg self-input "/clear"; sleep 2; cbg self-input "You are a successor session. A previous worker finished the earlier work and handed off. Read <HANDOFF_PATH> (and progress.md / the latest critic notes in the task directory), then complete ONLY the remaining items listed there. Do not re-do or re-explain prior work."
   ```

   Both inputs are buffered and processed after your turn ends: `/clear`
   wipes the conversation, then the successor prompt starts your fresh self
   on the remaining work.

3. Then STOP — end your turn and output nothing further.

## Notes

- Only works inside a cbg-managed claude session (`CBG_DTACH_SOCKET` set).
- Prefer **self_compact** unless the context genuinely needs wiping —
  compaction keeps your task summary automatically, so it's lower-risk.
- If you forget step 1, the successor will have no idea what to do. The
  handoff file is the only memory that survives `/clear`.
