# Heartbeat / Critic — Design Plan (v2)

A persistent timer-driven system that nudges worker sessions toward
long-horizon goals **and independently judges whether they're actually
making progress**. Heartbeat items live as files on disk; a stateless
critic (invoked via `claude -p` with sonnet, one call per item) judges
each due item individually. No batching, no persistent "vitals" session,
no self-certified completions.

## What changed from v1

1. **Vitals is no longer a long-running Claude session.** The critic is
   a stateless `claude -p --model sonnet --bare --json-schema …` call,
   spawned once per due item per tick. No persistent session to crash,
   no session id to keep alive, no MCP plumbing for it.
2. **No batching.** Every due item gets its own critic call. A backlog
   turns into parallel critic calls (bounded concurrency), never a
   single giant prompt where items can get forgotten.
3. **Target sessions cannot unilaterally mark things done.** When a
   worker calls `heartbeat_remove(id)`, that's a *removal request*, not
   a deletion. The critic reviews the request against evidence before
   the file actually disappears. This is the countermeasure to session
   shirking (worker talking itself into "this pre-existing failure is
   fine, removing the task").
4. **Delivery is deterministic.** The server (not an LLM) delivers
   nudges to target sessions. The critic only *decides* and *drafts the
   nudge text*; the server does the IPC.

## Goals

1. Long-horizon tasks survive any single session's attention span and
   any single session's rationalizations.
2. Independent judgment: the entity that decides "done" is NOT the
   entity doing the work.
3. Fail-safe: never lose an item; never delete one without a critic
   verdict recorded on disk.
4. Observable: items, verdicts, and nudge history are plain files you
   can `cat`.

## Architecture overview

```
    ┌─────────────────────────────────────────────────────────┐
    │ standalone-server.js                                    │
    │                                                         │
    │   setInterval ticker ── cbg config heartbeat.intervalMs │
    │         │                                               │
    │         ▼                                               │
    │   scanDueItems()     (no batching; list of due items)   │
    │         │                                               │
    │         ▼                                               │
    │   for each due item, in parallel up to MAX_CONCURRENCY: │
    │         │                                               │
    │         ├─► spawn `claude -p` critic call               │
    │         │     (sonnet, --bare, --json-schema)           │
    │         │     input: item + evidence bundle             │
    │         │     output: {verdict, nudgeText?, reasoning}  │
    │         │                                               │
    │         ├─► apply verdict:                              │
    │         │     nudge    → deliverToSession(target, text) │
    │         │     sharpen  → deliverToSession(target, text) │
    │         │                (with escalation framing)      │
    │         │     remove   → move item → verdicts/done/     │
    │         │     reject   → clear removalRequested flag    │
    │         │     escalate → reply to user on Telegram      │
    │         │     expire   → move item → verdicts/expired/  │
    │         │                                               │
    │         └─► append verdict to item's audit log          │
    └─────────────────────────────────────────────────────────┘
```

No persistent critic session. The critic exists only for the duration
of a single `claude -p` process.

## Heartbeat directory layout

```
~/.local/share/cbg/state/heartbeat/
    items/
        <id>.json            active items
        <id>.audit.jsonl     append-only verdict/delivery log per item
    verdicts/
        done/<id>.json       critic-approved removals (kept for inspection)
        expired/<id>.json    time- or user-expired items
        rejected-removal/    … (for debugging shirk-rejection cases)
    tmp/
        *.tmp.<pid>.<rand>   in-flight writes (swept on startup, >1h old)
```

Overridable via `cbg config heartbeat.dir`. The tmp/ subdir sits on the
same filesystem as items/ so `rename(2)` is atomic.

## Item schema

One file per item at `items/<id>.json`. Id is `randomHex(8)` from
`lib/protocol.js` — consistent across schema, logs, and UI (no mixing
`t-a1b2c3` with `a1b2c3d4e5f6a7b8`).

```jsonc
{
  "id": "a1b2c3d4e5f6a7b8",
  "type": "task",
  "createdAt": "2026-04-11T05:36:00Z",
  "createdBy": { "kind": "user" | "session", "id": "688903965" },
  "title": "finish the auth migration",
  "prompt": "continue the auth migration. last known progress: ...",
  "doneCondition": "all tests pass AND pre-existing failures are NOT acceptable AND PR is merged",

  // Routing — either a specific session or a cwd-based rebind rule.
  "target": {
    "kind": "session" | "cwd",
    "sessionId": "calmLion",        // when kind="session"
    "cwd": "/Users/jeff/repos/x"    // when kind="cwd" (any focused session in this cwd)
  },

  // Deterministic state tracked by the server.
  "lastDeliveredAt": null | "2026-04-11T05:35:00Z",
  "lastAckedAt": null | "2026-04-11T05:35:12Z",   // set when target confirms receipt
  "deliveryCount": 0,
  "sharpenCount": 0,                              // times critic escalated tone
  "minIntervalMs": 300000,                        // throttle floor
  "expiresAt": "2026-04-25T00:00:00Z",            // time-based, NOT count-based

  // Shirk countermeasure.
  "removalRequested": null | {
    "at": "2026-04-11T06:00:00Z",
    "bySessionId": "calmLion",
    "reasoning": "I verified CI is green on main, auth migration merged in #482",
    "evidence": ["git log -1 main", "gh pr view 482"]
  },

  // Bookkeeping.
  "createdHops": 0  // cross_session_message hop counter
}
```

**No `maxDeliveries`.** Expiry is time-based. Count-based expiry
contradicts the "survive a session's attention span" goal — a stubborn
task may take hundreds of nudges and that's fine as long as it's within
the deadline.

## Atomic writes

All writes use write-tmp-then-rename in the same filesystem. `touchItem`
updates bounded fields (`lastDeliveredAt`, `deliveryCount`,
`sharpenCount`, `lastAckedAt`, `removalRequested`, `expiresAt`) and is
the ONLY mutator the server uses. Concurrent touches: last-writer-wins
on scalar fields, which is acceptable because we never lose the file.

Audit entries append to `items/<id>.audit.jsonl` using `{ append: true }`
`Deno.writeTextFile`. JSON-lines is resilient to interrupted writes (the
worst case is a truncated trailing line, which the reader can skip).

## Tick loop

Lives in `lib/heartbeat.js`, started from `standalone-server.js`:

```js
let tickRunning = false

function startHeartbeat(server) {
    const intervalMs = config("heartbeat.intervalMs", 60_000)
    const tick = async () => {
        if (tickRunning) {
            dbg("HEARTBEAT", "tick still running, skipping")
            return
        }
        tickRunning = true
        try {
            const now = Date.now()
            const due = await scanDueItems(now)        // individual items, not batched
            await runWithConcurrency(due, MAX_CONCURRENCY, (item) => handleItem(server, item, now))
        } finally {
            tickRunning = false
        }
    }
    setInterval(tick, intervalMs)
}
```

`scanDueItems` returns items where either:
- `now - (lastDeliveredAt ?? 0) >= minIntervalMs`, OR
- `removalRequested !== null` (always route removal requests through
  the critic on the next tick regardless of throttle), OR
- `now >= expiresAt` (route to the critic for final "expire" verdict).

**Re-entry guard.** `tickRunning` prevents overlap if a tick runs long
(critic calls can take seconds). The interval keeps firing; overlapping
ticks are skipped cleanly.

**`MAX_CONCURRENCY`** defaults to 4. Each `claude -p` call is
independent; no shared state. Configurable via
`heartbeat.maxConcurrency`.

## Per-item handling

```js
async function handleItem(server, item, now) {
    const evidence = await gatherEvidence(server, item)
    const verdict = await runCritic(item, evidence)   // one `claude -p` call
    await appendAudit(item.id, { at: now, evidence, verdict })
    await applyVerdict(server, item, verdict, now)
}
```

### `gatherEvidence`

Fast, local, no LLM. Collects whatever the critic needs to judge this
specific item:

- Item metadata (id, title, doneCondition, deliveryCount, sharpenCount,
  age, last N audit entries).
- If `removalRequested` is set: the worker's stated reasoning and the
  evidence commands they cited.
- A peek into the target session's recent activity. Reuse
  `commands/peek.js` logic to pull the last ~50 lines of the session's
  transcript / tool history (bounded — we're not sending the whole
  session into a prompt).
- Optional: results of running the `evidence` commands from
  `removalRequested` (e.g. actually run `git log -1 main` and include
  the output). This is the critic's best protection against a shirking
  worker inventing plausible-sounding evidence.

`gatherEvidence` is synchronous from the critic's perspective — if
running an evidence command takes more than a few seconds, skip it and
note "evidence command timed out" in the bundle.

### `runCritic` — the `claude -p` call

```js
async function runCritic(item, evidence) {
    const prompt = renderCriticPrompt(item, evidence)
    const schema = {
        type: "object",
        required: ["verdict", "reasoning"],
        properties: {
            verdict: {
                type: "string",
                enum: ["nudge", "sharpen", "remove", "reject_removal", "escalate_user", "expire"]
            },
            reasoning: { type: "string" },
            nudgeText: { type: "string" },    // required when verdict ∈ {nudge, sharpen}
            userMessage: { type: "string" }   // required when verdict ∈ {escalate_user, expire}
        }
    }
    const proc = new Deno.Command("claude", {
        args: [
            "-p", prompt,
            "--model", "claude-sonnet-4-6",
            "--bare",
            "--json-schema", JSON.stringify(schema),
            "--max-budget-usd", "0.25",
            "--fallback-model", "claude-haiku-4-5-20251001"
        ],
        stdout: "piped",
        stderr: "piped"
    })
    const { stdout, stderr, code } = await proc.output()
    if (code !== 0) {
        dbg("HEARTBEAT", "critic failed:", new TextDecoder().decode(stderr))
        return { verdict: "nudge", reasoning: "critic call failed; defaulting to passive nudge", nudgeText: defaultNudge(item) }
    }
    return JSON.parse(new TextDecoder().decode(stdout))
}
```

`--bare` keeps the critic hermetic: no project CLAUDE.md, no hooks, no
memory, no plugin MCP — it's a pure judgment function on the evidence
we pass in. `--json-schema` forces structured output so parsing is
never heuristic. `--max-budget-usd` is a hard per-call ceiling.
`--fallback-model` lets haiku take over under sonnet overload.

### Critic prompt skeleton

```
You are the critic for a long-horizon task tracker. Your job is to
judge ONE task independently. The worker session may try to rationalize
its way out of the task — do not accept rationalizations. Evidence is
what matters.

TASK
  id: {id}
  title: {title}
  done condition: {doneCondition}
  created: {createdAt}, age: {ageHours}h
  deliveries so far: {deliveryCount} (sharpened: {sharpenCount})
  expires: {expiresAt}

TARGET SESSION ACTIVITY (last ~50 events)
  {peek excerpt}

REMOVAL REQUEST (if any)
  reasoning: {removalRequested.reasoning}
  cited evidence: {removalRequested.evidence}
  live evidence outputs:
    {evidence command results — these are the ground truth}

INSTRUCTIONS
  - If there is a removal request, compare the worker's reasoning to the
    live evidence. If the evidence does NOT clearly satisfy the done
    condition, emit "reject_removal" with reasoning that names the gap.
  - Pay special attention to pre-existing failures, skipped tests, TODO
    comments, or phrases like "good enough" — these are shirk signals.
  - If no removal request, decide between "nudge" (normal reminder),
    "sharpen" (worker has been nudged {deliveryCount} times with little
    visible progress), "escalate_user" (critic cannot judge; user must),
    or "expire" (past expiresAt).
  - For nudge/sharpen, write the exact text to deliver to the target.
    Sharpened nudges should cite specific shirk patterns you observed.
```

This prompt is the heart of the design. Iterate on it after the first
end-to-end test.

### `applyVerdict`

Deterministic, no LLM:

| Verdict           | Action                                                                 |
| ----------------- | ---------------------------------------------------------------------- |
| `nudge`           | `touchItem({lastDeliveredAt: now, deliveryCount++})`; `deliverToSession(resolveTarget(item), verdict.nudgeText, {source: "heartbeat"})` |
| `sharpen`         | same as nudge, plus `sharpenCount++`                                   |
| `remove`          | move item → `verdicts/done/`; delete `removalRequested`; ack the worker |
| `reject_removal`  | `touchItem({removalRequested: null})`; deliver a sharp nudge explaining what evidence was missing |
| `escalate_user`   | Telegram reply to `createdBy` with `verdict.userMessage`; `touchItem({lastDeliveredAt: now})` to throttle |
| `expire`          | move item → `verdicts/expired/`; Telegram reply with summary           |

**`deliverToSession` update order.** The current v1 plan updates
`lastDeliveredAt` before the IPC send, which creates a silent-drop
window if the send fails. New rule:

1. Send IPC to target session first.
2. Wait for an `ack` response (new IPC type). Ack is synchronous — the
   target session's shim confirms it received the channel_event before
   the server considers delivery successful.
3. On ack: `touchItem({lastDeliveredAt: now, lastAckedAt: now})`.
4. On error or timeout: leave `lastDeliveredAt` alone so the next tick
   re-tries sooner than `minIntervalMs` (we track a `deliveryFailCount`
   and retry on the next tick regardless of throttle, up to 3 times).

## Target resolution & rebinding

`item.target.kind === "session"`: look up the session id in
`server.sessions`. If gone, fall back to any focused session whose
`cwd` matches the original (if recorded at creation time). If still no
match, route to `escalate_user`.

`item.target.kind === "cwd"`: find the currently-focused session in
that cwd. No single id to go stale. This is the recommended mode for
tasks meant to outlive any individual session.

The `/task` command defaults to `kind: "cwd"` using the creating
session's cwd. Opt into `kind: "session"` with an explicit flag when
the work genuinely belongs to one specific session instance.

## Shirk countermeasure: `heartbeat_remove` is a request

The MCP tool exposed to sessions:

```js
{
    name: "heartbeat_remove",
    description: "Request removal of a heartbeat task. This is a REQUEST, not a deletion. An independent critic will verify your reasoning against live evidence before the task is actually removed. Provide specific, falsifiable evidence.",
    inputSchema: {
        type: "object",
        required: ["id", "reasoning"],
        properties: {
            id: { type: "string" },
            reasoning: { type: "string", description: "Why the done condition is met. Be specific; the critic will run evidence commands." },
            evidence: {
                type: "array",
                items: { type: "string" },
                description: "Shell commands the critic should run to verify your claim (e.g. 'git log -1 main', 'npm test')."
            }
        }
    }
}
```

Calling it sets `removalRequested` on the item and returns a
provisional response ("removal requested; critic will judge within one
tick"). The next tick fires the critic, which either moves the item to
`verdicts/done/` or clears the flag and delivers a `reject_removal`
nudge.

Why this matters: the worker session that has been staring at the code
for hours is the WORST judge of whether it finished. It has motivation
to move on, it has blind spots, and it will rationalize pre-existing
failures as "not my problem." The critic has zero sunk cost and only
sees what the evidence shows.

## Cross-session messaging

Unchanged from v1 in shape, plus two fixes:

- **Hop counter.** Every `cross_session_message` carries a `hops`
  field. Server rejects messages with `hops > 3`.
- **Per-pair delivery ledger with exponential backoff.** After a
  message from A → B, subsequent A → B messages need the interval
  `baseCooldown * 2^(count within window)`. Resets after 10 minutes of
  quiet. This replaces v1's weak 5-second cooldown.

Audit: every cross_session_message is logged to `messages.jsonl` with
`source: "cross-session"`, `from`, `reason`, `hops` — so `/doctor` can
display provenance chains.

## `/task` command

```
user: /task fix the failing auth tests :: done when CI is green on main
      AND no tests are skipped or xfailed
bot:  Created task a1b2c3d4e5f6a7b8
      target: cwd /Users/jeff/repos/x (will route to whichever session is focused here)
      done condition: CI is green on main AND no tests are skipped or xfailed
      nudge interval: 5 min | expires: 2026-04-25 (in 14 days)
      I'll nudge until the critic approves a removal.
```

Parser:
- Body split on ` :: done when ` (fallback to ` :: `).
- Without a done condition: error ("`/task` requires a done condition").
- Optional flags: `--session calmLion` (hard-bind), `--interval 10m`,
  `--expires 3d`. Defaults from config.
- All bot replies use HTML parse_mode per project convention.

Related commands:
- `/task_list` — list active items.
- `/task_done <id>` — user-side manual removal (bypasses critic; only
  the user has this privilege).
- `/task_cancel <id>` — user-side expire with reason.
- `/task_show <id>` — dump item + audit log.

## Configuration

```yaml
heartbeat:
  intervalMs: 60000
  dir: ~/.local/share/cbg/state/heartbeat
  maxConcurrency: 4
  defaultTaskIntervalMs: 300000
  defaultExpiresInMs: 1209600000   # 14 days
  criticModel: claude-sonnet-4-6
  criticFallbackModel: claude-haiku-4-5-20251001
  criticMaxBudgetUsd: 0.25
```

## File / module inventory

New files:
- `lib/heartbeat.js` — schema, scanner, atomic update helpers, tick
  loop, interval registry, `runCritic`, `applyVerdict`, concurrency
  limiter.
- `lib/critic-prompt.js` — `renderCriticPrompt(item, evidence)`. Kept
  separate so the prompt can be iterated without touching control flow.
- `lib/evidence.js` — `gatherEvidence(server, item)`: peek excerpt,
  bounded evidence command execution with timeout.
- `commands/task.js` — `/task`, `/task_list`, `/task_done`,
  `/task_cancel`, `/task_show`.

Touched files:
- `standalone-server.js` — `startHeartbeat()` on init; IPC handlers for
  `cross_session_message`, `heartbeat_list`, `heartbeat_remove`
  (request), `channel_event_ack`; re-entry guard.
- `shim.js` — expose `cross_session_message` and `heartbeat_remove` as
  MCP tools; emit `channel_event_ack` when a channel_event is
  delivered into the session.
- `lib/protocol.js` — new IPC message types.
- `lib/config.js` — defaults for new keys.

**Explicitly removed from v1:** no `commands/vitals.js`, no
`vitalsSessionId`, no reserved session id, no auto-spawn question. The
critic is a subprocess, not a session.

## Failure modes

| Failure                                    | What happens                                            | Mitigation                                          |
| ------------------------------------------ | ------------------------------------------------------- | --------------------------------------------------- |
| `claude -p` call fails (non-zero exit)     | default to passive `nudge` with boilerplate text        | item stays on disk; next tick tries critic again    |
| `claude -p` returns invalid JSON           | shouldn't happen with `--json-schema`, but same fallback| same                                                |
| sonnet overloaded                          | `--fallback-model` promotes haiku for this call         | degraded but live                                   |
| critic call exceeds `--max-budget-usd`     | exits non-zero → fallback nudge                         | hard budget cap per call                            |
| target session crashed during delivery     | no ack → delivery marked failed                         | retry on next tick, up to 3 attempts                |
| target session id gone (kind=session)      | rebind to same-cwd focused session, else escalate_user  | cwd-mode target avoids this entirely                |
| no focused session in target cwd           | escalate_user once, then throttle                       | user decides; item stays active                     |
| worker shirks (requests removal falsely)   | critic runs evidence commands, rejects                  | `reject_removal` → sharpened nudge citing the gap   |
| critic itself shirks                       | critic is stateless + sees only evidence + sonnet; low risk | inspect audit log; tune prompt                  |
| tick takes >intervalMs                     | `tickRunning` guard skips overlapping tick              | no storms                                           |
| daemon crash mid-tmp-write                 | tmp file orphaned, real file unchanged                  | startup sweep removes `tmp/*.tmp.*` older than 1h   |
| heartbeat dir missing on boot              | `mkdir -p` all subdirs on `startHeartbeat()`            | no lazy failures                                    |
| rapid-fire `/task` from Telegram           | each creates a file; critic handles them independently  | no batching collapse                                |
| cross-session A→B→A loop                   | hops counter + exponential per-pair backoff             | loop dies quickly                                   |
| user `rm -rf heartbeat/`                   | items lost                                              | not our problem; document                           |
| infinite nudging (task never satisfiable)  | `expiresAt` triggers `expire` verdict                   | time-based, not count-based                         |

## Cost & latency notes

Per tick (worst realistic case): 10 due items × ~3s sonnet latency at
concurrency 4 → ~8s total wall time. Re-entry guard means this is fine
even at a 60s interval. Budget at `$0.25` per call × 10 items = `$2.50`
worst case per tick, but realistic items with short evidence will cost
a few cents each. Set `criticMaxBudgetUsd` lower after calibration.

If a steady state of ~30 items eventually materializes, expect roughly
30 critic calls per tick interval. At 60s intervals that's ~43k calls
per day, which is absurd — tune `minIntervalMs` per item up to
30–60min for that regime. The design doesn't force 60s; items control
their own throttle.

## Open design questions

1. **Should the critic also see the full `doneCondition` parsed into
   sub-claims?** E.g. split "CI green AND no skipped tests" into two
   checks and report which failed. (Recommendation: no — let sonnet do
   the parsing inside the prompt; structured sub-claims are brittle.)
2. **Per-item CLAUDE.md for critics?** Could allow project-specific
   shirk patterns ("never accept 'flaky test' as a removal reason in
   this repo"). (Recommendation: yes eventually, via an optional
   `heartbeat.criticSystemPromptFile` path appended with
   `--append-system-prompt-file`.)
3. **Should the worker see critic rejections verbatim or paraphrased?**
   Verbatim is more informative but may feel adversarial. (Recommendation:
   verbatim with a `[critic]` prefix. The point IS adversarial.)
4. **Heartbeat item visibility**: should sessions see items that
   target other sessions? (Recommendation: no. `heartbeat_list` returns
   only items routed to the calling session.)

## Implementation order

1. `lib/heartbeat.js` scaffolding: schema, `scanDueItems`, atomic
   `touchItem`, directory init, startup sweep. Unit-testable without
   any critic integration.
2. `lib/evidence.js` + `lib/critic-prompt.js`: build the evidence
   bundle and prompt from a hand-written test item. Verify the prompt
   reads well before wiring the tick.
3. `runCritic` spawn harness. Test with hand-written items of each
   verdict type; confirm JSON-schema output parses.
4. Tick loop + `applyVerdict`. Initially only the `nudge` path; log
   what *would* happen for other verdicts. Re-entry guard from day one.
5. Ack-based delivery: new IPC type, shim emits ack, server tracks
   `lastAckedAt` and retries on no-ack.
6. `/task` command family. End-to-end smoke test: create a task,
   watch the critic nudge the target, target calls `heartbeat_remove`,
   critic approves, file moves to `verdicts/done/`.
7. Shirk test: create a task with a strict done condition, have the
   target request removal with weak reasoning, confirm the critic
   rejects and delivers a sharpened nudge.
8. Cross-session messaging with hop counter + per-pair backoff.
9. Failure-mode shakedown: kill target mid-delivery, kill daemon
   mid-tmp-write, corrupt an item file, exhaust `maxConcurrency`,
   force `claude -p` to fail, push past `expiresAt`.
