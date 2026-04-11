# Heartbeat / Vitals — Design Plan

A persistent timer-driven system that nudges sessions toward long-horizon
goals. Recurring "heartbeat items" live as files on disk; a special "vitals"
Claude session evaluates them on each tick and dispatches reminders to other
sessions until those sessions decide the work is done.

## Goals

1. Make long-horizon tasks survive a single Claude session's attention span.
2. Decouple *what to do* (the heartbeat item) from *who is doing it* (a
   target session). Items outlive sessions.
3. Be fail-safe by default — never lose an item, never delete one before the
   work it represents is finished.
4. Stay observable and debuggable: items are plain files you can `cat`.

## Architecture overview

```
                ┌──────────────────────┐
                │  standalone-server   │
                │                      │
                │  setInterval ticker  │  ← cbg config heartbeat.intervalMs
                │         │            │
                │         ▼            │
                │  scan heartbeat dir  │
                │         │            │
                │   batch due items    │
                │         │            │
                └─────────┼────────────┘
                          │ IPC: channel_event
                          ▼
              ┌──────────────────────────┐
              │  vitals session          │
              │  (a regular Claude with  │
              │   reserved id "vitals")  │
              │                          │
              │  decides per item:       │
              │   • cross-message a      │
              │     target session       │
              │   • update item meta     │
              │   • remove (rare; only   │
              │     when judging done)   │
              └────────────┬─────────────┘
                           │ MCP tool: cross_session_message
                           ▼
              ┌──────────────────────────┐
              │  target session(s)       │
              │  see the message as if   │
              │  the user typed it       │
              │                          │
              │  may call:               │
              │   heartbeat_remove(id)   │
              └──────────────────────────┘
```

## Heartbeat directory & item schema

Path: `~/.local/share/cbg/state/heartbeat/` (overridable via
`cbg config heartbeat.dir`).

One file per item, named `<id>.json`. The id is a random hex string (use
`randomHex(8)` from `lib/protocol.js`).

```jsonc
{
  "id": "a1b2c3d4e5f6a7b8",
  "type": "task" | "watch" | "reminder",
  "createdAt": "2026-04-11T05:36:00Z",
  "createdBy": { "kind": "user" | "session", "id": "688903965" | "calmLion" },
  "targetSessionId": "calmLion",          // who should act on it
  "title": "finish the auth migration",   // human-friendly label
  "prompt": "continue the auth migration. last known progress: ...",
  "doneCondition": "all tests pass and PR is merged",
  "lastDelivered": null | "2026-04-11T05:35:00Z",
  "deliveryCount": 0,
  "minIntervalMs": 300000,                // throttle floor between deliveries
  "maxDeliveries": 50,                    // safety cap; null = unbounded
  "ownerLock": null                       // see "Reliable removal" below
}
```

`type` is informational; today only `task` does anything special (the
done-condition loop).

## The fail-safe rule: vitals never deletes

This is the core invariant.

> The only entities allowed to delete a heartbeat item are the **target
> session** (after deciding the done condition is met) and the **user** (via
> a Telegram command). Vitals is a *messenger*, not an arbiter.

Why: the target session has the actual context to know whether the work is
done. Vitals only sees what's in the file and what it has been told. If
vitals deletes eagerly the work is lost forever; if vitals never deletes,
the worst case is one extra nudge — recoverable.

Corollary: a heartbeat item is removed by `heartbeat_remove(id)` from the
target session, or by `/task_done <id>` from the user. Never by the ticker.

## Reliable update / atomicity

All writes use the **write-tmp-then-rename** pattern:

```
write `${dir}/${id}.json.tmp.${pid}.${random}`
rename → `${dir}/${id}.json`
```

POSIX `rename(2)` is atomic within a filesystem, so readers either see the
old version or the new — never a partial write.

The ticker updates `lastDelivered` and `deliveryCount` *before* sending the
message to vitals. If vitals or the IPC drops the message, the worst case is
one missed delivery; the next tick (one `minIntervalMs` later) re-delivers.
Updating *after* would risk re-delivery storms when vitals is slow to ack.

There is no need for filesystem locks. Multiple writers (e.g. a
heartbeat_update from vitals running concurrently with a tick update from
the server) could overlap, but the worst case is one update overwriting the
other's metadata. Both writers operate on bounded fields (lastDelivered,
deliveryCount, minIntervalMs) and we accept last-writer-wins. We do *not*
accept losing the file itself, which the rename pattern guarantees.

## The tick loop

Lives in a new `lib/heartbeat.js`, started from `standalone-server.js`.

```js
function startHeartbeat(server) {
    const intervalMs = config("heartbeat.intervalMs", 60_000)
    const tick = async () => {
        const now = Date.now()
        const items = await scanDueItems(now)         // sorted by lastDelivered asc
        if (items.length === 0) return
        const batch = items.slice(0, MAX_BATCH)        // never overwhelm vitals
        for (const item of batch) {
            await touchItem(item.id, { lastDelivered: now, deliveryCount: item.deliveryCount + 1 })
        }
        const vitals = server.sessions.get("vitals")
        if (!vitals) return                            // vitals offline → no-op, items stay on disk
        server.deliverToSession("vitals", renderPrompt(batch), { source: "heartbeat" })
    }
    setInterval(tick, intervalMs)
}
```

`scanDueItems` reads the directory, parses each JSON file (skipping
malformed ones with a `dbg("HEARTBEAT", "skip", err)`), and returns those
where `now - (lastDelivered ?? 0) >= minIntervalMs`.

### Why batching, not one-message-per-item

Vitals is a Claude session. Each message costs tokens and risks rate
limits. Batching N due items into one prompt lets vitals reason about them
together, prioritize, and dispatch in a single pass. `MAX_BATCH` (default
10) prevents vitals from ever drinking from a firehose if a backlog
accumulates after downtime.

### What if vitals is down?

The tick is a no-op. Items keep accumulating their `minIntervalMs` debt but
no work is lost — they're just files. When vitals reconnects, the next tick
processes whatever's due. No queue, no replay, no special recovery code.

## Cross-session messaging

New MCP tool exposed by `shim.js`:

```js
{
    name: "cross_session_message",
    description: "Send a message to another Claude session by id, as if the user typed it.",
    inputSchema: {
        type: "object",
        properties: {
            sessionId: { type: "string" },
            text: { type: "string" },
            reason: { type: "string", description: "Why this is being sent (for audit log)." }
        },
        required: ["sessionId", "text"]
    }
}
```

The shim forwards the call as a new IPC type `cross_session_message`. The
standalone server handles it by calling the existing `deliverToSession`
helper used by `/chat_<id>`. The receiving session sees a normal
`channel_event` notification — same path as inbound Telegram text, so the
target session can't tell the difference (and doesn't need to).

Audit: every cross_session_message is logged to `messages.jsonl` with a
`source: "cross-session", from: "<sessionId>", reason: "..."` field, so
`/doctor` can show the full provenance chain.

### Loop protection

A session that just received a cross_session_message must NOT be allowed to
immediately fire one back to the sender on the same tick. Track a per-pair
edge with a 5-second cooldown:

```js
const recentEdges = new Map()  // "from->to" -> ts
```

This is loose by design — humans loop tasks across sessions on purpose; we
just want to break the obvious A→B→A→B storm.

## The /task command

Telegram-side flow:

```
user: /task fix the failing auth tests :: done when CI is green
bot:  Created task t-a1b2c3 → calmLion (current session)
      done condition: CI is green
      I'll re-deliver every 5min until calmLion calls heartbeat_remove(t-a1b2c3)
```

Parser:
- Optional first token `<session_id>` to override target
  (`/task calmLion fix tests :: done when …`)
- Body split on ` :: done when ` (or the more compact ` :: `)
- Without a done condition: error and ask for one
  ("`/task` requires a done condition. Use `:: done when …`")

The command writes a new heartbeat item to the directory and replies with
the id. No state lives in the command itself.

`/task_done <id>` lets the user manually mark complete (deletes the file
after a confirmation reaction). `/task_list` shows current items.

## How "done" actually gets detected

This is the trickiest part. Two layers:

### Layer 1: target session decides (primary)

Every cross_session_message from vitals carries a structured suffix:

```
[heartbeat task t-a1b2c3]
done when: CI is green
prompt: continue the auth migration. last progress: ...

If the done condition is met right now, call the
`heartbeat_remove` MCP tool with id "t-a1b2c3" before doing anything
else. Otherwise resume work and stop when you've made meaningful
progress.
```

The target session has the actual context (file state, test results,
recent thoughts) and is the only entity that can reliably judge done. It
calls `heartbeat_remove(t-a1b2c3)` and the file disappears.

### Layer 2: vitals as backup judge (after escalation)

If `deliveryCount >= 5` and the item is still around, vitals starts
including a `please verify done state` instruction in the next batch
prompt. Vitals can read the target session's recent log via a `peek` tool
(reuse `commands/peek.js` logic exposed as MCP) and decide.

If `deliveryCount >= maxDeliveries`, vitals notifies the *user* via a
direct Telegram reply ("task t-a1b2c3 has been delivered N times with no
removal — should I stop?") and moves the file to `heartbeat/.expired/`.

## Server timing tracker

A small registry in `lib/heartbeat.js`:

```js
const intervals = new Map()  // name -> { handle, intervalMs, lastTick, runs }

export function registerInterval(name, ms, fn) { ... }
export function unregisterInterval(name) { ... }
export function listIntervals() { ... }
```

Today only the heartbeat tick uses this, but it's the obvious place to add
future timed jobs (token rotation, garbage collection, telemetry flush) and
gives `/doctor` something to introspect.

## Configuration

New `cbg config` keys (all optional, defaults shown):

```yaml
heartbeat:
  intervalMs: 60000           # how often the ticker fires
  dir: ~/.local/share/cbg/state/heartbeat
  vitalsSessionId: vitals     # reserved session id
  maxBatchSize: 10            # max items per delivery to vitals
  defaultTaskIntervalMs: 300000   # default minIntervalMs for /task items
  defaultMaxDeliveries: 50    # safety cap for /task items
```

## File / module inventory

New files:
- `lib/heartbeat.js` — schema, scanner, atomic update helpers, tick loop,
  interval registry
- `commands/task.js` — `/task`, `/task_done`, `/task_list` Telegram commands
- `commands/vitals.js` — `/vitals_start`, `/vitals_status`, `/vitals_stop`
- `docs/heartbeat-plan.md` — this doc

Touched files:
- `standalone-server.js` — wire `startHeartbeat()` after bot startup; add
  IPC handlers for `cross_session_message`, `heartbeat_list`,
  `heartbeat_remove`, `heartbeat_update`
- `shim.js` — expose new MCP tools (`cross_session_message`,
  `heartbeat_list`, `heartbeat_remove`, `heartbeat_update`); proxy through
  IPC
- `lib/telegram-api.js` — handle the new IPC tool dispatches
- `lib/config.js` — defaults for the new keys (just doc; the lookup
  function is generic)

## Failure modes — checklist

| Failure                              | What happens                                  | Mitigation                                       |
| ------------------------------------ | --------------------------------------------- | ------------------------------------------------ |
| vitals session crashes mid-tick      | items remain on disk, no metadata loss        | next tick re-delivers when vitals reconnects     |
| vitals never started                 | ticks are no-ops                              | items pile up safely; user starts vitals later   |
| target session crashed               | cross_session_message returns error           | item retains lastDelivered; next tick re-tries   |
| target session id no longer exists   | vitals gets error from cross_session_message  | vitals notifies user via Telegram, marks expired |
| infinite delivery loop               | deliveryCount reaches maxDeliveries           | item moves to `.expired/`, user notified         |
| done condition never met             | item is delivered forever                     | maxDeliveries cap; user can `/task_done` manually |
| concurrent metadata writes           | last-writer-wins on bounded fields            | acceptable; only file deletion is dangerous      |
| daemon crash mid-write of metadata   | tmp file orphaned, real file unchanged        | startup sweep removes `*.tmp.*` older than 1h    |
| user `rm -rf` on heartbeat dir       | items lost                                    | not our problem; warn in docs                    |
| heartbeat dir on a different fs than tmp | rename across fs fails                     | tmp file lives in same dir as target; safe       |
| vitals decides wrong, deletes item early | impossible — vitals has no delete tool      | invariant: only target session + user can delete |

## Open design questions (flag for review before implementing)

1. **Auto-spawn vitals?** Should `cbg start` auto-launch the vitals session
   if any heartbeat items exist? Or always require manual `/vitals_start`?
   (Recommendation: lazy auto-spawn on first item creation.)

2. **Multiple vitals?** Could you ever want a vitals-per-project? The
   current plan assumes one global vitals.

3. **Done-condition language**: free text vs structured (e.g.
   `condition: { kind: "tests-pass", path: "..." }`). Free text is simpler
   and lets the LLM judge; structured is more reliable but rigid.
   (Recommendation: free text now, structured later if abuse appears.)

4. **/task without focused session**: error or default to spawning a new
   session via `/new`? (Recommendation: error — explicit is safer.)

5. **Heartbeat item visibility to non-target sessions**: should sessions
   see items that target other sessions? (Recommendation: no — vitals only
   sees its own batched view; sessions only see items that target them via
   `heartbeat_list_for_me`.)

6. **Persistence across daemon restart**: items live on disk so they
   already survive. But "in-flight" deliveries (sent to vitals, not yet
   processed) — do we need a `inflight/` subdir? (Recommendation: no, the
   metadata `lastDelivered` is enough; over-delivery is preferable to
   under-delivery.)

## Implementation order (when ready to build)

1. `lib/heartbeat.js` — schema + atomic update helpers + interval registry
   (no tick loop yet, no MCP integration). Unit-testable in isolation.
2. Wire `startHeartbeat()` into `standalone-server.js`. Tick fires but only
   logs — no delivery yet.
3. New IPC type `cross_session_message`; expose via shim MCP tool. Test
   manually with two sessions.
4. Vitals session protocol — render batched prompt, deliver via existing
   `deliverToSession`. Manual test with hand-edited heartbeat files.
5. `commands/task.js` — `/task`, `/task_done`, `/task_list`. End-to-end
   test: create a task, watch vitals nudge the target, target removes it.
6. Failure-mode shakedown: kill vitals mid-tick, kill target mid-message,
   create item with bad JSON, rapid-fire `/task` calls.
