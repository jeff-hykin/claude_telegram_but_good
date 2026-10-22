# Button questions

Ask the user a multiple-choice question they answer by **tapping a button** in
Telegram, from anywhere: a Claude session, a slash command (builtin or custom),
or a shell script. The answer is routed back to whoever asked.

The send side of inline keyboards already existed. What was missing was the
return path: `lib/event-handlers/telegram-callback-query.js` understood exactly
two `callback_data` prefixes (`perm:`, `cmderr:`) and logged every other tap
into the void, so a new button was decorative.

## Asking

**From a Claude session** — the `ask_user_question` MCP tool:

```
ask_user_question(
    question: "still want this todo?",
    options: ["Keep", "Drop"],           // or [{key,label}], 2-5 of them
    context: "fix the sink — added 4 months ago",   // optional, one line
    answer_to: "topic:life",             // optional; defaults to your topic
    timeout_seconds: 86400,              // optional; default 24h, max 7d
)
→ { question_id: "q_m1k2j3ffff" }
```

It returns **immediately** — it does not block. The answer arrives later as a
channel event, the way a reminder does:

```
[answer to question q_m1k2j3ffff: Keep (key: keep)]
question was: "still want this todo?"
```

**From a slash command** (including a custom one, which must have zero
imports) — return a follow-up event:

```js
export const commands = {
    stale_todo: async (event, _core) => ({
        followUpEvents: [{
            type: "ask_user_question",
            question: "still want this todo?",
            options: ["Keep", "Drop"],
            context: "fix the sink",
            askedBy: { kind: "command", id: "stale_todo" },
            chatId: event.chatId,
            threadId: event.threadId,
            // answerTo defaults to the topic it was asked in
        }],
    }),
}
```

**From anything else** — the CLI:

```bash
# fire and forget: prints the question id, answer lands in an inbox
cbg question --text "deploy now?" --options "Ship,Hold"

# block until the tap, print the answer as JSON (exit 2 if it expired)
cbg question --text "deploy now?" --options "Ship,Hold" --sync
```

## Getting the answer back

`answerTo` is one of the existing target-resolver addresses, and it is
**resolved at answer time, not at ask time**:

| `answerTo` | delivery |
|---|---|
| `session:<id>` | channel event to that session |
| `topic:<name>` | channel event to the session in that topic; if none is connected, the `topic:<name>` inbox |
| `inbox:<addr>` | inbox write + wakes a parked `cbg question --sync` |
| absent | the question's own id as an inbox address |

Resolving late is what makes a `/refresh` survivable: the topic follows the
work even though the session id changes. That is why a session's default
`answerTo` is its topic, not its id.

Every answer is **also** appended to the `user_questions` inbox, whatever else
happens to it:

```bash
cbg inbox latest --address user_questions
```

So a harness that died mid-question can still find out what the user said.

## When nobody is waiting any more

- **The question outlives a restart.** The registry is
  `chatState.pendingQuestions`, which is persisted, and the callback handler
  reads state rather than memory — so the buttons still work after the daemon
  restarts. Only the expiry timer is re-armed on boot
  (`user_question_rehydrate`).
- **Unanswered questions expire** (default 24h, max 7d). The asker is told:
  it gets the same delivery with `status: "expired"`, so a `--sync` CLI stops
  waiting instead of hanging forever.
- **A tap on a dead question** answers the callback query with "expired or
  already answered" and strips the keyboard off the message. It never hangs
  and never throws.
- **An answered question's keyboard is edited away**, so the same question
  cannot be answered twice.
- **An unreachable asker** degrades to an inbox write. An answer is never
  dropped because the asker went away.

## Size limits

The IPC bridge truncates around 8 KB and Telegram caps `callback_data` at 64
bytes, so: question ≤ 600 chars, context ≤ 400, 2-5 options, labels ≤ 40
chars. The wire payload is only `q:<questionId>:<index>` — never the label,
never the answer. Oversized asks are refused with an error rather than
silently truncated.

## Files

| file | role |
|---|---|
| `lib/pure/user-questions.js` | wire format, validation, keyboard, message text |
| `lib/user-question-actions.js` | `buildAskAction` (where to ask) + `routeAnswer` (where the answer goes) |
| `lib/event-handlers/ask-user-question.js` | the one handler all three ask paths converge on |
| `lib/event-handlers/telegram-callback-query.js` | the `q:` branch |
| `lib/event-handlers/user-question-expire.js` | expiry, and re-arming an early fire |
| `lib/event-handlers/user-question-rehydrate.js` | re-arms expiry after a restart |
| `event-generators/cli/commands/question.js` | `cbg question` |
| `tests/handler-user-question-test.js` | all of the above |
