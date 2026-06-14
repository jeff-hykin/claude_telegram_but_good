---
name: self_compact
description: Compact your OWN conversation context by running /compact on yourself. Use when your context window is getting large, or when a long-task critic tells you to reset and continue as a fresh successor. Only works inside a cbg-managed claude session.
allowed-tools: Bash(cbg self-input:*)
---

# self_compact — compact your own context

This types `/compact` into your own session, so Claude Code summarizes your
conversation and frees up the context window. Your task and recent work are
PRESERVED in the compaction summary — `/compact` does not erase anything,
it condenses it.

## When to use

- Your context is getting large and you want to keep working without losing
  the thread.
- A long-task critic told you that you're wrapping up early / making excuses /
  treating partial progress as done, and to reset and continue as a
  **successor**. Compacting gives you a cleaner head while keeping the list of
  remaining work in the summary, so you can finish the contract.

## How

1. Run exactly:

   ```
   cbg self-input "/compact"
   ```

2. Then STOP — end your turn and output nothing further. The `/compact` is
   typed into your prompt and runs once your current turn ends.

3. After compaction completes, keep going: complete the remaining items
   (they survive in the summary). If you were told to act as a successor,
   adopt that mindset — the earlier work is done; your only job now is to
   finish what remains. Don't re-explain or re-do prior work.

## Notes

- Only works inside a cbg-managed claude session, where `CBG_DTACH_SOCKET`
  is set. If `cbg self-input` reports it isn't set, you can't self-compact.
- If your context is so polluted (lots of rationalizing / dead ends) that a
  clean summary won't help, use the **self_clear** skill instead — but only
  after writing your remaining work to a durable file, because `/clear`
  erases everything.
