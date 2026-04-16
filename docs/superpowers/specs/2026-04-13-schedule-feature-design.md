# /schedule feature — design spec

Branch: `schedule-feature`
Worktree: `~/repos/cbg1`
Author: brainstormed 2026-04-13

## Overview

A `/schedule` system that lets the user describe a recurring task ("every day at 3pm, check my github profile for number of commits that day"), has the focused worker draft a definition of done + produce a mechanical RRULE-based schedule, locks it via an MCP tool, then fires headless `claude --no-tele` workers inside dtach on the schedule. A critic subprocess judges each run against the definition of done, iterates with the worker through revisions via dtach stdin, and when certified, the main-server sends the result to the user's Telegram chat. The worker session is invisible to `/list` (not registered with the shim at all).

## User-visible surface

### New chat commands

- `/schedule <description>` — two-phase drafting flow, mirrors `/task`. Creates a scheduled-task in state `defining`, hands the focused worker a drafting prompt. Worker clarifies with user (timezone, what output, what DoD) and submits via MCP tool.
- `/schedule_cancel_<id>` — hard-cancel a scheduled task. Clears its timer, marks terminal, deletes its entry from `specialData.scheduledTaskByChatId`.
- `/schedule_pause_<id>` — toggles `tracking.skipNext` so the next fire is skipped. Another call un-pauses.
- `/schedule_view_<id>` — dump the rule, DoD, and recent run history for inspection.
- `/schedule_status_<id>` — terse one-line status with `nextFireAt`, `lastRunAt`, `lastRunStatus`, `totalRuns`.
- `/cron` (existing) — extended to include CBG-managed scheduled tasks from `specialData.scheduledTaskByChatId` alongside the existing Claude-plugin-skill listing.

### New MCP tool

`submit_scheduled_task_definition` — lock-in step. Called by the drafting worker. Parameters:

```
{
  scheduleTaskId: string,
  rule: { freq, interval?, byhour?, byminute?, byday?, bymonth?, bymonthday?, until?, count?, tzid? },
  definitionOfDone: string (markdown),
  title?: string
}
```

Returns success or error (unknown task id, wrong session, state not `defining`, invalid rule).

### Drafting prompt (template the focused worker receives)

1. Normal goal: write `definition_of_done.md` that is concrete, falsifiable, and specifies where the output artifact should be written.
2. Schedule-specific clauses:
   - Produce a mechanical `rule` object suitable for the `rrule` library. Supported fields: `freq` (MINUTELY/HOURLY/DAILY/WEEKLY/MONTHLY/YEARLY), `interval`, `byhour`, `byminute`, `byday`, `bymonth`, `bymonthday`, `until`, `count`, `tzid`.
   - **Timezone clarification rules** (must be followed before calling the MCP tool):
     - If `config.yaml` has `schedule.default_tz` set, silently use it (and mention it in the confirmation).
     - Else if the rule has no time-of-day component (e.g., a monthly or yearly rule where the user didn't specify a time), silently default `tzid` to the daemon's system tz (`Intl.DateTimeFormat().resolvedOptions().timeZone`) and say so in the confirmation.
     - Else if the user's wording carries context ("in the morning", "before my meeting at 2pm", "after work") — infer a time/tz and **echo the inference explicitly** in the confirmation (e.g., "I'll schedule this for 9:00 AM America/Los_Angeles — change it with `/schedule_update_<id>` if that's wrong").
     - Otherwise ask explicitly: "Should this always fire at <time> in your current timezone (`<system tz>`) or fixed in a specific timezone?" Wait for an answer before calling the tool.
   - Sunrise/sunset and "follow me while traveling" are NOT supported in v1 — agent must push back if requested.
3. The DoD's content must explicitly name the output file path the worker should write when it runs. The critic reads that file to judge completion. Example: "Write the daily commit count to `report.md` in the run directory."

## Architecture

### Data: new `specialData` slice

```js
specialData.scheduledTaskByChatId = {
  [chatId]: {
    [scheduleTaskId]: {
      id,
      title,
      createdAt,
      originalPrompt,        // user's /schedule <text>
      definitionOfDone,      // locked markdown
      rule,                  // rrule.js JSON options (see below)
      state: "defining" | "scheduled" | "running" | "errored" | "cancelled",
      draftingSessionId,     // session currently drafting the definition; null after lock
      tracking: {
        totalRuns: 0,
        lastRunAt: null,
        lastRunStatus: null,      // "certified" | "escalated" | "errored" | "cancelled"
        lastRunSummary: null,
        nextFireAt: null,         // ISO string, advisory only (recomputed from rule on startup)
        skipNext: false,
        runHistory: [],           // ring buffer of last 10 {iso, status, summary}
      },
      // Only populated while a run is in flight:
      currentRun: null,    // { runIso, runDir, dtachSocket, logFile, attempt, startedAt, criticState } | null
    }
  }
}
```

Persisted via existing debounced `specialData.json` write (same mechanism long tasks use). No new JSON backup file needed; the persistence-layer debounce **is** the ".json backup" the user referenced.

### Data: `rule` shape

Passed directly to `rrule.js` (esm.sh import). Full rrule.js option fields allowed, but the drafting prompt restricts the agent to a subset for simplicity (freq/interval/byhour/byminute/byday/bymonth/bymonthday/until/count/tzid). No `dtstart` — we use `createdAt` as the implicit dtstart. Timezone lives directly on the rule as `tzid`, resolved to a concrete IANA string at rule-creation time.

### Module layout (new files)

```
lib/scheduler/
  index.js                    # exports computeNextFire(rule, fromIso), validateRule(rule)
lib/effects/
  scheduled-task-worker.js    # spawnScheduledTaskWorker, killScheduledTaskWorker
lib/event-handlers/
  scheduled-task-definition-submitted.js   # MCP tool → event → handler
  scheduled-task-fire.js                   # timer fired → kick off a run
  scheduled-task-run-complete.js           # certified or terminal → send telegram, advance timer
commands/
  schedule.js                 # /schedule chat command (two-phase drafting, mirrors /task)
```

Modified files:

```
event-generators/mcp-server/mcp-shim-tool-handler.js   # add submit_scheduled_task_definition tool + IPC path
lib/pure/ipc-inbound.js                                # translate new IPC message to event
lib/main-event-processor.js                            # register handlers + effect
lib/event-handlers/chat-user.js                        # /schedule dispatch + /schedule_* dynamic regex
lib/paths.js                                           # add SCHEDULED_TASKS_DIR + helpers
lib/effects/persistence.js                             # no change — same specialData debounce
main-server.js                                         # on startup, reinit timers for every persisted scheduled task
imports.js                                             # add rrule.js import
commands/cron.js                                       # add CBG-managed scheduled-task rendering
lib/config-manager.js                                  # add getScheduleDefaultTz() / setScheduleDefaultTz()
```

### Directory layout

```
$CBG_DIR/scheduled-tasks/<scheduleTaskId>/
  definition_of_done.md             # written at lock time
  rule.json                         # human-readable snapshot of the rule
  runs/
    <iso-fire-timestamp>/
      instructions.md               # what the worker was told this run
      report.md                     # worker's output (path is referenced by DoD)
      certification.md | requested_revisions.md   # critic verdict
      critic_output.attempt{N}.log  # critic subprocess evidence
      worker.log                    # dtach log tail for the worker session (symlink or copy)
```

The WORKER'S CWD IS `$CBG_DIR/scheduled-tasks/<scheduleTaskId>/` (the task dir, not the run dir). The DoD tells the worker where to write its output — typically a per-run path like `runs/<iso>/report.md`, which we pass in the kickoff message.

### Events (new)

| Event type | Source | Payload |
|---|---|---|
| `scheduled_task_definition_submitted` | shim MCP call | `{ scheduleTaskId, rule, definitionOfDone, title, sessionId, requestId, _conn }` |
| `scheduled_task_fire` | `setTimeout` fire (from the `schedule_timer` effect) | `{ scheduleTaskId, chatId, fireIso }` |
| `scheduled_task_run_complete` | `scheduled-task-worker.js` after critic verdict | `{ scheduleTaskId, chatId, runIso, status, summary }` |

Existing events reused: `critic_verdict` (the same critic subprocess handles both long-task and scheduled-run reports — we differentiate by looking up the taskId in either registry).

### Effects (new)

| Effect type | Purpose |
|---|---|
| `schedule_timer_set` | Compute `nextFireAt` from rule, `setTimeout` to enqueue a `scheduled_task_fire` event. Cancels any prior timer for the same taskId. |
| `schedule_timer_clear` | Clear the setTimeout for a given taskId (used on cancel/pause/restart). |
| `scheduled_task_worker_spawn` | Spawn `claude --no-tele` inside dtach at the task's cwd, write kickoff prompt to stdin via `dtach -p`, register an internal watcher that polls the run dir + dtach log. |
| `scheduled_task_worker_kill` | Kill the dtach session for a completed/cancelled run. |

The in-memory `setTimeout` handles per-task timer state; a `Map<scheduleTaskId, timerId>` lives as a module-level singleton in `lib/scheduler/timer-registry.js` (module-internal state, not on `core`). On daemon startup, `main-server.js` iterates `specialData.scheduledTaskByChatId` and emits `schedule_timer_set` effects for each non-terminal task. Persistence of `nextFireAt` is advisory — the source of truth is the `rule` field, and next-fire is always recomputed on boot.

### Schedule fire → run lifecycle

1. `scheduled_task_fire` event lands in the queue.
2. Handler checks `tracking.skipNext`: if true, clear it, emit a `schedule_timer_set` for the next slot, done.
3. Otherwise, handler transitions the task to state `running`, generates a `runIso` = current ISO, creates `runs/<runIso>/`, writes `instructions.md` (the DoD + per-run context like "the current run dir is runs/<runIso>/, write your output there"), and emits a `scheduled_task_worker_spawn` effect.
4. `scheduled_task_worker_spawn` (effect):
   - Generates a dtach socket path at `$CBG_DIR/scheduled-tasks/<taskId>/runs/<runIso>/dtach.sock` (keeps per-run evidence together).
   - Spawns `claude --no-tele ...` in that dtach. `--no-tele` skips CBG shim wiring → the session is invisible to main-server's chatSessions registry.
   - cwd = `$CBG_DIR/scheduled-tasks/<taskId>/` (task dir).
   - Strips `CLAUDE_/MCP_` env vars (same hygiene as critic-subprocess).
   - After a brief readiness window (watch dtach log for Claude's interactive prompt marker, same pattern as `watchForTrustPrompt` in new.js), inject a kickoff via `dtach -p`: `"Read ./runs/<runIso>/instructions.md and complete the task. The DoD is in ./definition_of_done.md."`
   - Starts a **worker watcher** coroutine: polls the run dir for `report.md` appearance OR stops when the dtach log goes idle for N seconds. This is similar to the stop-hook-based detection long tasks use, but since there's no shim, no Stop hook fires — we rely on dtach log stability as the idle signal.
   - When `report.md` appears, emits a `spawn_critic` effect for a `scheduledTask:<runDir>` target (critic-subprocess.js gets a new branch to accept either `longTaskId` or `scheduledRunDir` input).
5. Critic subprocess runs, writes `certification.md` or `requested_revisions.md`, enqueues `critic_verdict`.
6. `critic_verdict` handler (existing) gets a new branch for scheduled runs:
   - **certified** → enqueue `scheduled_task_run_complete` with status "certified".
   - **revisions** → write `revision_request.md` into the run dir, then use `dtach -p` to inject a revision prompt into the worker: `"Revisions requested — read ./runs/<runIso>/revision_request.md, update ./runs/<runIso>/report.md, and continue."` Critic re-arms on next `report.md` rewrite. Dtach-log-stability check before injection (the footgun from `53e0c37` — we must wait for the worker to be idle before dtach -p, or the injection is lost).
   - **indecisive / error** → retry up to 3, then mark run `errored` and emit `scheduled_task_run_complete` with status "errored".
7. `scheduled_task_run_complete` handler:
   - Emits `scheduled_task_worker_kill` effect (tears down the dtach session).
   - Updates `tracking`: increments `totalRuns`, appends to `runHistory`, sets `lastRunAt`/`lastRunStatus`/`lastRunSummary`, clears `currentRun`.
   - Emits a `send_text_to_user` with a short summary (certified: include excerpt of `report.md`; errored: include critic escalation notes).
   - Emits `schedule_timer_set` to advance to the next fire, unless rule has `until`/`count` exhausted → task state transitions to `completed` (terminal, timer not rearmed, kept in specialData for history, user can `/schedule_cancel` to delete).

### Why no `deliver_channel_event` for worker comms

The footgun commit `53e0c37` showed that `send_text_to_claude` (dtach -p) silently vanishes when Claude isn't at the interactive prompt — the Stop hook blocks I/O and ate the injection. The fix for long tasks was to use `deliver_channel_event` (MCP notification) instead.

Scheduled task workers don't have a shim, so `deliver_channel_event` isn't an option. Instead, we dodge the footgun the same way critic-subprocess dodges its own version of it: **watch the dtach log for stability before injecting.** The spawn effect waits until `claude` prints its interactive prompt banner before the kickoff inject; the revision inject waits until the log has been quiet for N seconds. Both are concrete checks of "is the worker actually at the prompt," not timing guesses.

### Missed-fire policy

If the daemon was down when a scheduled fire time passed, on next startup we compute next-fire from now and ignore the missed slot. Log "missed fire" to cold storage. The alternative (fire-on-boot to catch up) risks a flood of stale runs if the daemon was off for days.

### Cold storage logging

New cold storage stream: `"scheduled-tasks"`. Events logged: `defined`, `locked`, `fire`, `run_started`, `run_certified`, `run_errored`, `skipped`, `cancelled`, `paused`, `unpaused`.

## Error handling

- Invalid rule at MCP tool submission time → tool returns error, task stays in `defining`, drafting worker can try again.
- `rrule.js` throws on `computeNextFire` → mark task `errored`, send telegram alert, clear timer.
- Worker spawn fails (dtach not installed, claude not found) → `scheduled_task_run_complete` with status `errored`, telegram alert, timer advances normally.
- Worker watcher times out (dtach log fully idle with no `report.md` after a configurable wall-clock budget, default 15 min) → kill dtach, mark run errored, proceed.
- Critic indecisive 3 times → same as long task escalation, marks run errored.
- Daemon restart mid-run: on startup, any task with `currentRun != null` is treated as orphaned. The orphan handler kills the dtach sock if it still exists, marks the run errored, clears `currentRun`, and rearms the timer.

## Testing

Unit tests (in `tests/`, `deno test --allow-all`):

- `lib/scheduler/index.js` — `computeNextFire` against a table of rules + reference dates. Covers daily with tzid, weekly byday, monthly bymonthday, interval-only, until/count termination, DST transitions.
- `lib/scheduler/index.js` — `validateRule` rejects unknown freq, missing freq, invalid byday, bad tzid.
- `scheduled-task-definition-submitted` handler — state machine: wrong session, wrong state, dup lock, valid submission.
- `scheduled-task-fire` handler — respects `skipNext`, creates run dir, transitions to running.
- `scheduled-task-run-complete` handler — updates tracking ring buffer, rearms timer, sends user message, clears `currentRun`.

Integration smoke test (manual, documented): `/schedule every minute say hi in report.md`, watch for 2 consecutive certified runs + telegram messages, then `/schedule_cancel_<id>`.

## Config additions

```yaml
schedule:
  default_tz: "America/Los_Angeles"   # optional; if set, agent uses silently
  worker_timeout_ms: 900000            # 15 min per-run wall clock cap
  critic_max_retries: 3
```

Backwards-compatible: all fields optional with safe defaults.

## Out of scope for v1

- Sunrise/sunset anchors (needs solar library + lat/long)
- "Follow me while traveling" dynamic tzid (needs user-location signal)
- Interactive schedule editing mid-flight (user must cancel + re-create)
- Cross-device schedule sync
- Web UI for schedule management
- Retroactive fire-on-boot for missed runs

## Open questions (deferred, non-blocking)

- Should `runHistory` live in cold storage only (JSONL append) instead of specialData? For now, both (ring buffer in specialData for fast `/schedule_status` rendering, full history in cold storage for `/schedule_view` detail). Revisit if specialData bloats.
- Should a terminal `state: "completed"` (rule exhausted via `until`/`count`) auto-delete after N days, or require explicit `/schedule_cancel`? Default: require explicit cancel; keeps the history visible in `/cron`.
