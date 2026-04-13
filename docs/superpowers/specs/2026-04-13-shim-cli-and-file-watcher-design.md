# Design: `cbg claude` subcommand + dtach-aware PID walk + live shim file watcher

**Date:** 2026-04-13
**Status:** draft (awaiting user review)
**Origin:** Telegram message 1526 — "Let's add PID walk detection that gives a better error message when dtach isnt found. Let's make a cbg claude command that behaves as the shimmed Claude, and rewrite the shell script. … As for the shim. Let's use Deno's file watcher system inside the daemon. Have it watch the claude command, and as soon as claude modifies it re-shim it."

## 1. Motivation

Three related problems, all of which bit us in recent sessions:

1. **Silent non-dtach sessions.** `SurprisingRooster` registered with the daemon with `inDtach: false` — no dtach process in its ancestry — and nobody knew until `/list` output showed "has no dtach socket" and the user asked "what happened?". The PID-walk helper in `lib/pid.js` has all the information to detect this case at register time but doesn't surface a warning.
2. **Bash shim is hard to change.** `event-generators/cli/shim-setup.js:shimScript()` is a ~80-line POSIX-sh function doing arg parsing, passthrough detection, permission-file reading, dtach-spawn logic, and `next_session.json` writing. Any change requires editing shell, duplicating path constants from `lib/paths.js`, and testing across sh dialects. The bash duplicates logic that would be 15 lines in JS.
3. **Shim gets clobbered by Claude Code auto-update.** `lib/shim-health.js` polls once per 20 s at event dispatch time and reinstalls when the shim is missing — but that leaves a 20-second window every time Claude Code updates where the shim is broken, and during that window the user's `claude` invocations bypass cbg entirely, producing exactly the SurprisingRooster failure mode.

## 2. Goals

- When a session registers without dtach in its ancestry, surface a clear, timely warning (Telegram + daemon log) so the user knows to fix the root cause, and mark the session's `chatSessions` entry with `inDtach: false` for rendering in `/list`.
- Move ~all of the bash shim's logic into a JS `cbg claude` subcommand. The bash shim becomes ~3 lines: "deno on PATH?" check, then `exec cbg claude "$@"`.
- The daemon watches the installed `claude` shim path with `Deno.watchFs()` and reinstalls within ~200 ms of any modification, eliminating the auto-update shim-clobber window.

## 3. Non-Goals

- Replace the current Claude Code auto-update flow or lobby upstream to not clobber shims.
- Rewrite `commands/new.js` (which already has its own dtach-spawn path used when the user types `/new` in Telegram).
- Move the shim install/uninstall helpers out of `event-generators/cli/shim-setup.js` — they stay where they are.
- Add telemetry or usage tracking.

## 4. Architecture

Three independent components. Each can ship separately, in any order. The only coupling is that the PID-walk warning is most useful once the shim is reliably installed (components 2 + 3).

```
┌───────────────────────────────────────────────────────┐
│ 1. PID-walk dtach detection                           │
│   lib/pid.js                 findDtachPidStrict(pid)  │
│   lib/event-handlers/        session-register.js     │
│     ↳ emits session_register_no_dtach warning event  │
│   lib/event-handlers/        session-register-no-dtach.js (new)
│     ↳ logs, marks session.inDtach=false,              │
│       debounced Telegram warning via send_text_to_user│
└───────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────┐
│ 2. `cbg claude` subcommand                            │
│   event-generators/cli/commands/claude.js (new)       │
│     ↳ arg parsing, passthrough detection,             │
│       --channels injection, permission-file read,     │
│       dtach spawn, next_session.json write            │
│   event-generators/cli/cli.js                         │
│     ↳ new case "claude": dispatch to claude.js        │
│   event-generators/cli/shim-setup.js                  │
│     ↳ shimScript() becomes ~3 lines of bash:          │
│         #!/bin/sh                                     │
│         command -v deno >/dev/null || { warn; exit }  │
│         exec cbg claude "$@"                          │
└───────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────┐
│ 3. Live shim file watcher                             │
│   lib/effects/shim-watcher.js (new) — or folded into  │
│     lib/shim-health.js                                │
│   main-server.js                                      │
│     ↳ startShimWatcher() called after persistence     │
│       load, before bot start                          │
│   Daemon lifecycle: watcher runs for lifetime of      │
│     process; stop on shutdown                         │
└───────────────────────────────────────────────────────┘
```

## 5. Component 1 — PID-walk dtach detection

### 5.1 Helper: `findDtachPidStrict`

New function in `lib/pid.js`, parallel to `findClaudePidStrict`:

```js
// Given a starting PID (typically the claude pid from
// findClaudePid), walk the ancestry up to 10 levels looking
// for a `dtach` process whose args reference the session's
// socket path. Returns the dtach pid if found, or null.
//
// Match condition: args starts with "dtach " (first word of
// argv is literally "dtach" or "/path/to/dtach"). This is
// the same word-boundary approach as findClaudePidStrict.
export function findDtachPidStrict(startPid) { … }
```

The match regex is `^(?:\S*\/)?dtach(?:\s|$)` — same shape as the fixed-up `findClaudePidStrict` regex.

### 5.2 Hooking into session_register

`lib/event-handlers/session-register.js` currently receives a shim's `register` IPC frame and creates/updates a `chatSessions[sid]` entry with metadata from the shim's `ownSessionInfo()`. The shim already sends `pid` (the claude pid) and `dtachSocket` (if it was spawned under dtach).

**Change:** in the handler, after computing the session entry, also run `findDtachPidStrict(session.pid)`. Set the new field `session.inDtach` to `true` if a dtach ancestor was found, `false` otherwise. The existing `dtachSocket` field stays as the shim reported it (may be empty for non-dtach sessions).

If `inDtach === false`, ALSO emit a follow-up event `session_register_no_dtach` carrying `{ sessionId, chatId?, cwd, gitBranch }`. We use a follow-up event rather than inline effects so the warning path is independent of the register handler — e.g., we can add a `session_register_no_dtach` unit test without dragging in all the register-handler fixtures.

### 5.3 New handler: `session-register-no-dtach.js`

New event handler that:
- Logs the warning to `main.log` via `dbg("SHIM-WARN", …)`.
- Consults a debounce map on `core.chatState.noDtachWarnings: { [cwd]: lastWarnedAt }`. Skip the Telegram warning if we've already warned for this `cwd` within the last hour.
- Emits a `send_text_to_user` effect with the warning text. The target `chatId` is whichever chat is currently paired with the user — read from `loadAccess()` the same way `/start` does. If the access list is empty (unpaired), skip the Telegram warning and just log.
- Updates `core.chatState.noDtachWarnings[cwd] = Date.now()` via `stateChanges`.

### 5.4 Warning message

```
⚠️ Session <id> (cwd: <cwd>, branch: <branch>) registered without dtach
in its ancestry. /peek, /cancel, /pause, /resume won't work for it.

This usually means the cbg claude shim got clobbered — try `cbg reinstall`.
```

## 6. Component 2 — `cbg claude` subcommand

### 6.1 New file: `event-generators/cli/commands/claude.js`

Mirrors the existing `event-generators/cli/commands/{new,onboard,reinstall}.js` layout. Exports `runClaude(args)` that is invoked from the CLI dispatcher.

Logic, in order (same as the current bash shim):

1. **`--no-tele` strip.** If `args[0] === "--no-tele"`, `args.shift()` and `Deno.exec` the real claude binary (`_claude_before_cbg` sibling) with the rest of the args. This is the escape hatch that lets the user bypass cbg entirely.

2. **Passthrough detection.** If `args[0]` is one of `agents|auth|auto-mode|doctor|install|mcp|plugin|plugins|setup-token|update|upgrade`, OR any arg is `-p|--print|-v|--version|-h|--help`, set `passthrough = true`. Passthrough means "non-interactive invocation — don't wrap in dtach, don't inject channels". Exec the real binary with the original args.

3. **Permission + channel arg injection.** If neither `--channels` nor `--permission-mode`/`--dangerously-skip-permissions` is present in args, inject `--channels plugin:telegram@claude-plugins-official` and whatever `paths.PERMISSION_ARGS_FILE` says.

4. **Dtach availability check.** If `dtach` is NOT on PATH:
   - Print a clear error (same style as `commands/new.js`: "dtach not found. Install it with: brew install dtach / apt-get install dtach / nix profile install nixpkgs#dtach").
   - **Continue anyway** — exec the real binary with the injected channels args. This matches the existing bash shim's fallback (`exec "$REAL" $EXTRA_ARGS "$@"`).

5. **Dtach spawn.** Generate a random 6-hex socket id. Write `paths.NEXT_SESSION_FILE` with `{ dtachSocket }`. Export `CBG_DTACH=1` and `CBG_DTACH_SOCKET=<sock>`. Run `dtach -c <sock> -z <realClaude> <channels> <userArgs>` with stdout/stderr teed to `<sock-without-.sock>.log`.

### 6.2 Shared argument parser

All the passthrough-detection + arg-inject logic extracts into a pure function `parseClaudeShimArgs(args, { permArgs })` returning `{ mode: "notele" | "passthrough" | "interactive", injectArgs: [...], userArgs: [...] }`. Pure function, easy to unit-test. Lives in `lib/pure/claude-shim-args.js`.

### 6.3 New bash shim script

`shimScript()` in `event-generators/cli/shim-setup.js` becomes:

```sh
#!/usr/bin/env sh
# <SHIM_MARKER>
# Installed by cbg (claude_telegram_but_good)
# Delegates to `cbg claude`. To remove: cbg uninstall.
if ! command -v deno >/dev/null 2>&1; then
    echo "cbg claude shim: 'deno' not on PATH. Install: https://deno.land/" >&2
    exec "$(dirname "$0")/_claude_before_cbg" "$@"
fi
if ! command -v cbg >/dev/null 2>&1; then
    echo "cbg claude shim: 'cbg' not on PATH. Install: https://raw.githubusercontent.com/jeff-hykin/claude_telegram_but_good/refs/heads/master/event-generators/cli/cli.js" >&2
    exec "$(dirname "$0")/_claude_before_cbg" "$@"
fi
exec cbg claude "$@"
```

Both fallbacks exec the real binary so a broken deno/cbg install doesn't brick the user's `claude` command. The existing `_claude_before_cbg` sibling is preserved as-is by `installShim()`.

### 6.4 CLI dispatch

Add to `event-generators/cli/cli.js`:

```js
case "claude": {
    const { runClaude } = await versionedImport("./commands/claude.js", import.meta)
    await runClaude(args)
    break
}
```

`cbg claude` is NOT added to `printUsage()` — it's a shim-internal entry point, not a user-facing command. Documenting it in help would invite confusion ("should I type `cbg claude`? No — just `claude`").

## 7. Component 3 — Live shim file watcher

### 7.1 New file: `lib/effects/shim-watcher.js`

Exports `startShimWatcher(core)`. Called once from `main-server.js` after persistence load, before the bot starts.

Flow:
1. Compute the shim path via `findClaudeBinary()` from `event-generators/cli/shim-setup.js`. If no claude on PATH, log and bail — the watcher can only run if claude exists.
2. Open `Deno.watchFs(path, { recursive: false })` — watch just the shim file.
3. In a background async loop, consume events. Any event of kind `modify | create | remove | rename` → schedule a debounced check.
4. Debounce window: 200 ms. Drop back-to-back events in the same window so a single atomic rename (rm + write) doesn't fire twice.
5. On debounce fire: call `isShimInstalled()`. If `true` → log `"shim still intact"` at debug level and return. If `false` → call `installShim()` and log the result.
6. If `watchFs` throws (platform quirk, file deleted, fd exhaustion), log and restart the watcher after a 5 s delay. A "failure" here means the outer `for await (const event of watcher)` loop has thrown or returned — not an individual event's debounce fire. Give up after 3 consecutive restart failures (15 s total) and fall back to the periodic `maybeHealShim()` poll.

### 7.2 Interaction with `lib/shim-health.js`

`lib/shim-health.js` already has a periodic check called from `onEvent`, currently throttled to one filesystem probe per 20 s. Keep it as a **safety net**: bump its `THROTTLE_MS` constant to `300_000` (5 min), and add a log marker `"SHIM_HEAL: safety-net check"` so it's clear from logs that the watcher is the primary mechanism and the poller is a fallback. If the watcher is running fine the safety-net check will consistently find the shim intact and become essentially a no-op. If the watcher crashes or misses an event, the safety net catches us within 5 min worst-case.

### 7.3 Clobber scenario walkthrough

1. User runs `npm i -g @anthropic-ai/claude-code` in any terminal.
2. npm rewrites `$PATH/claude` (the cbg shim) with a symlink to the real npm-installed cli.
3. `Deno.watchFs` fires a `modify` or `rename|create` event for the file.
4. 200 ms debounce window opens.
5. No further events → debounce fires → `isShimInstalled()` returns `false` (our marker is gone).
6. `installShim()` runs, detects `alreadyShimmed === false`, renames the npm symlink to `_claude_before_cbg`, writes our shim back.
7. Total clobber window: ≤ 200 ms + a few ms for the rename/write.

### 7.4 Tests

Write `tests/shim-watcher-test.js` with two test cases:
- **Happy path:** mkdir a temp dir, touch a fake "claude" file with the shim marker, start the watcher, truncate the file (clobber simulation), assert the file gets rewritten within 500 ms. This requires refactoring `installShim()` to accept a target path instead of always calling `findClaudeBinary()` — the refactor is small and justified.
- **Noop path:** same setup, but write a file that already has the shim marker. Watcher fires, `isShimInstalled()` returns true, no write occurs.

## 8. Data flow

No new persisted state. All three components operate on existing in-memory data structures:

- Component 1 adds two fields: `session.inDtach` (per-session) and `chatState.noDtachWarnings` (map of cwd → timestamp). Both are persisted via existing `chatSessions.json` / `chatState.json` writes.
- Component 2 has no state — it's a pure CLI command.
- Component 3 has no state — the watcher is a detached async loop.

## 9. Error handling

| Failure | Response |
|---|---|
| `findDtachPidStrict` can't run `ps` | Log, treat as "dtach not in ancestry" (false negative). Do not crash register. |
| `session_register_no_dtach` handler can't read access.json | Log, skip Telegram warning, still mark `inDtach: false`. |
| `runClaude` can't find `_claude_before_cbg` | Print error to stderr, exit with code 127 (command not found). This is the same behavior as bash failing on `$REAL`. |
| `parseClaudeShimArgs` sees an unknown mode | Default to passthrough (don't wrap in dtach, don't inject channels). Safer than crashing. |
| `Deno.watchFs` throws on startup | Log, retry after 5 s, give up after 3 attempts, log a prominent "file watcher disabled" warning. Safety-net poller still runs. |
| `installShim()` fails during a watcher-triggered reinstall | Log, wait for next file event. Safety-net poller will retry. |

## 10. Testing strategy

**Unit tests (all new):**

- `tests/pure/claude-shim-args-test.js` — the pure arg parser. Covers `--no-tele` strip, each passthrough subcommand, each passthrough flag, interactive mode with `--channels` already present, interactive mode with `--permission-mode` already present, empty args, args with spaces/quotes.
- `tests/pid-test.js` — extend the existing test file (if any) or create one. `findDtachPidStrict` match regex tests. Mock `ps` via a helper.
- `tests/handler-session-register-no-dtach-test.js` — new. Assert the handler logs, marks `inDtach: false`, emits the Telegram warning once but not twice within the debounce window.
- `tests/shim-watcher-test.js` — see section 7.4.

**No end-to-end test** for the bash shim → `cbg claude` round-trip. The `parseClaudeShimArgs` unit tests cover the logic; running a real `claude` child in a test would be flaky and expensive.

## 11. Migration / rollout

1. Ship component 1 (PID-walk + warning) first. No user-visible breakage; just adds a warning.
2. Ship component 2 (`cbg claude` + new bash shim) second. Requires `cbg reinstall` to swap the old bash shim for the new one. Any session that was using the old shim and is still running is unaffected — the old shim is still valid shell, it just won't be written to disk anymore.
3. Ship component 3 (file watcher) last. Requires a daemon restart (not just hot reload) since `main-server.js` needs to wire up the watcher at startup.

## 12. Open questions (for user review)

1. **Component 1 surface:** currently planning "daemon log + /list marker + debounced Telegram warning". Alternative is to reject the register entirely (stronger signal, but leaves user with a broken session until fix).
2. **Safety-net poller throttle:** bump from 20 s to 5 min once the watcher is the primary path. Or drop the poller entirely?
3. **Test the bash shim directly:** I'm punting on integration tests for `cbg claude` vs. bash-shim. Is that ok?

If no answer, I'll pick the first option in each list above.

## 13. Affected files

**New:**
- `lib/pure/claude-shim-args.js`
- `lib/effects/shim-watcher.js`
- `lib/event-handlers/session-register-no-dtach.js`
- `event-generators/cli/commands/claude.js`
- `tests/pure/claude-shim-args-test.js`
- `tests/handler-session-register-no-dtach-test.js`
- `tests/shim-watcher-test.js`

**Modified:**
- `lib/pid.js` — add `findDtachPidStrict`.
- `lib/event-handlers/session-register.js` — call `findDtachPidStrict`, emit follow-up event on false.
- `lib/main-event-processor.js` — dispatch entry for `session_register_no_dtach`.
- `event-generators/cli/cli.js` — new `case "claude"`.
- `event-generators/cli/shim-setup.js` — rewrite `shimScript()` to the 3-line delegator; extract `isShimInstalled()` to accept an optional path arg (for the watcher test).
- `lib/shim-health.js` — bump throttle to 5 min, re-label as safety-net.
- `main-server.js` — start the shim watcher after persistence load.
