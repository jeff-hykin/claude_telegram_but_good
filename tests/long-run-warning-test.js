// tests/long-run-warning-test.js
//
// The long-run warning:
//   - ps parsing (etime formats, args with spaces)
//   - only a session's Bash-tool wrapper shells count, not its MCP servers,
//     hooks or other children, nor another session's shells
//   - one warning per command, one per session per cooldown, parallel runs
//     folded into one message, warned pids pruned once they exit
//   - the handler asks for a scan, warns through send_text_to_claude, and
//     long_run_warn_after_ms: 0 turns it off
//   - the snapshot tick drives it

import { assertEquals, assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, makeCore, effectsOfType, paths } from "./_helpers.js"

setupTempPaths("cbg-long-run-test-")

const {
    parseEtime,
    parsePsTable,
    bashToolCommand,
    commandPreview,
    formatElapsed,
    planLongRunWarnings,
} = await import("../lib/pure/long-runs.js")
const longRunCheck = (await import("../lib/event-handlers/long-run-check.js")).default
const snapshot = (await import("../lib/event-handlers/tui-snapshot.js")).default

const CLAUDE_PID = 5006
const MIN = 60_000
const WARN_AFTER = 5 * MIN
const COOLDOWN = 15 * MIN

function bashToolArgs(command) {
    const quoted = command.replaceAll("'", "'\\''")
    return `/bin/bash -c source /Users/x/.claude/shell-snapshots/snapshot-bash-1-abc.sh 2>/dev/null || true && shopt -u extglob 2>/dev/null || true && eval '${quoted}' < /dev/null && pwd -P >| /tmp/claude-8dba-cwd`
}

function proc(pid, elapsedMs, args, ppid = CLAUDE_PID) {
    return { pid, ppid, elapsedMs, args }
}

function session(patch = {}) {
    return { id: "S", pid: CLAUDE_PID, _conn: {}, dtachSocket: "/tmp/dtach-S.sock", ...patch }
}

function plan(sessions, processes, now = 100 * MIN) {
    return planLongRunWarnings({ sessions, processes, now, warnAfterMs: WARN_AFTER, cooldownMs: COOLDOWN })
}

function writeConfig(obj) {
    Deno.mkdirSync(paths.CONFIG_FILE.replace(/\/[^/]+$/, ""), { recursive: true })
    Deno.writeTextFileSync(paths.CONFIG_FILE, JSON.stringify(obj))
}

// ── ps parsing ────────────────────────────────────────────────────────

Deno.test("long-run: parseEtime handles every ps etime shape", () => {
    assertEquals(parseEtime("00:07"), 7_000)
    assertEquals(parseEtime("14:10"), (14 * 60 + 10) * 1000)
    assertEquals(parseEtime("02:34:29"), ((2 * 60 + 34) * 60 + 29) * 1000)
    assertEquals(parseEtime("04-16:15:06"), (((4 * 24 + 16) * 60 + 15) * 60 + 6) * 1000)
    assertEquals(parseEtime("garbage"), null)
})

Deno.test("long-run: parsePsTable keeps args with spaces and skips junk lines", () => {
    const table = parsePsTable("  101     1   01:00 /sbin/launchd\n 7714  5006   06:01 /bin/bash -c sleep 400\n\nnot a row\n")
    assertEquals(table, [
        { pid: 101, ppid: 1, elapsedMs: 60_000, args: "/sbin/launchd" },
        { pid: 7714, ppid: 5006, elapsedMs: 361_000, args: "/bin/bash -c sleep 400" },
    ])
})

Deno.test("long-run: bashToolCommand recovers the eval'd command, quotes included", () => {
    assertEquals(bashToolCommand(bashToolArgs("ssh jetson 'make -j8'")), "ssh jetson 'make -j8'")
    assertEquals(bashToolCommand("node /repo/mcp-server.js"), null)
    assertEquals(bashToolCommand("deno run -A /cbg/event-generators/hooks/hook.js"), null)
})

Deno.test("long-run: commandPreview is one line and truncated; formatElapsed is compact", () => {
    assertEquals(commandPreview("a\n  b"), "a b")
    assertEquals(commandPreview("x".repeat(200)).length, 80)
    assertEquals(formatElapsed(452_000), "7m32s")
    assertEquals(formatElapsed(7_380_000), "2h03m")
})

// ── planning ──────────────────────────────────────────────────────────

Deno.test("long-run: only this session's Bash-tool shells past the threshold count", () => {
    const processes = [
        proc(10, 60 * MIN, "node /repo/FableCut/mcp-server.js"),
        proc(11, 60 * MIN, "deno run -A /cbg/event-generators/mcp-server/mcp-shim.js"),
        proc(12, 60 * MIN, "caffeinate -i -t 300"),
        proc(13, 60 * MIN, bashToolArgs("sleep 9999"), 4242),
        proc(14, 2 * MIN, bashToolArgs("deno test")),
    ]
    assertEquals(plan({ S: session() }, processes).warnings, [])

    const { warnings, sessionPatches } = plan({ S: session() }, [...processes, proc(15, 7 * MIN + 32_000, bashToolArgs("cargo build --release"))])
    assertEquals(warnings.length, 1)
    assertEquals(warnings[0].sessionId, "S")
    assertStringIncludes(warnings[0].text, "[automated reminder] A command has been running >5 min (cargo build --release, 7m32s)")
    assertStringIncludes(warnings[0].text, "Don't wait on it")
    assertEquals(sessionPatches.S.longRunWarnedPids, [15])
    assertEquals(sessionPatches.S.lastLongRunWarnAt, 100 * MIN)
})

Deno.test("long-run: disconnected and non-Claude sessions are skipped", () => {
    const processes = [proc(15, 10 * MIN, bashToolArgs("make"))]
    assertEquals(plan({ S: session({ _conn: undefined }) }, processes).warnings, [])
    assertEquals(plan({ S: session({ backend: "codex" }) }, processes).warnings, [])
})

Deno.test("long-run: parallel runs fold into one message naming the newest", () => {
    const { warnings, sessionPatches } = plan({ S: session() }, [
        proc(20, 6 * MIN, bashToolArgs("run a")),
        proc(21, 40 * MIN, bashToolArgs("run b")),
        proc(22, 9 * MIN, bashToolArgs("run c")),
    ])
    assertEquals(warnings.length, 1)
    assertStringIncludes(warnings[0].text, "(run a, 6m00s, +2 more)")
    assertEquals(sessionPatches.S.longRunWarnedPids, [21, 22, 20])
})

Deno.test("long-run: once per command, once per session per cooldown", () => {
    const old = proc(30, 20 * MIN, bashToolArgs("old run"))
    const already = plan({ S: session({ longRunWarnedPids: [30], lastLongRunWarnAt: 0 }) }, [old])
    assertEquals(already.warnings, [], "a warned command is never warned again")
    assertEquals(already.sessionPatches, {})

    const newer = proc(31, 6 * MIN, bashToolArgs("new run"))
    const cooling = plan({ S: session({ longRunWarnedPids: [30], lastLongRunWarnAt: 100 * MIN - 5 * MIN }) }, [old, newer])
    assertEquals(cooling.warnings, [], "inside the cooldown a new command waits")

    const later = plan({ S: session({ longRunWarnedPids: [30], lastLongRunWarnAt: 100 * MIN - 16 * MIN }) }, [old, newer])
    assertEquals(later.warnings.length, 1)
    assertStringIncludes(later.warnings[0].text, "(new run, 6m00s)")
    assertEquals(later.sessionPatches.S.longRunWarnedPids, [30, 31])
})

Deno.test("long-run: warned pids are pruned once their command exits", () => {
    const stillRunning = proc(41, 30 * MIN, bashToolArgs("still"))
    const { warnings, sessionPatches } = plan({ S: session({ longRunWarnedPids: [40, 41], lastLongRunWarnAt: 100 * MIN }) }, [stillRunning])
    assertEquals(warnings, [])
    assertEquals(sessionPatches.S, { longRunWarnedPids: [41] })
    assertEquals(plan({ S: session({ longRunWarnedPids: [40], lastLongRunWarnAt: 100 * MIN }) }, []).sessionPatches.S, { longRunWarnedPids: undefined })
})

// ── handler + tick ────────────────────────────────────────────────────

Deno.test("long-run: the handler scans, then warns through send_text_to_claude", () => {
    writeConfig({})
    const core = makeCore({ chatSessions: { S: session() } })

    const scan = longRunCheck({ type: "long_run_check", ts: 1 }, core)
    assertEquals(scan.effects, [{ type: "scan_long_runs" }])
    assertEquals(longRunCheck({ type: "long_run_check", ts: 1 }, makeCore({ chatSessions: {} })), null, "nothing to watch, no ps")

    const action = longRunCheck({ type: "long_run_check", ts: 100 * MIN, processes: [proc(15, 8 * MIN, bashToolArgs("pytest -x"))] }, core)
    const sends = effectsOfType(action, "send_text_to_claude")
    assertEquals(sends.length, 1)
    assertEquals(sends[0].sessionId, "S")
    assertStringIncludes(sends[0].text, "(pytest -x, 8m00s)")
    assertEquals(action.stateChanges.chatSessions.S.longRunWarnedPids, [15])
})

Deno.test("long-run: long_run_warn_after_ms 0 turns it off; the threshold is configurable", () => {
    const core = makeCore({ chatSessions: { S: session() } })
    const processes = [proc(15, 3 * MIN, bashToolArgs("make"))]

    writeConfig({ long_run_warn_after_ms: 0 })
    assertEquals(longRunCheck({ type: "long_run_check", ts: 1 }, core), null)
    assertEquals(longRunCheck({ type: "long_run_check", ts: 1, processes: [proc(15, 60 * MIN, bashToolArgs("make"))] }, core), null)

    writeConfig({ long_run_warn_after_ms: 2 * MIN })
    const action = longRunCheck({ type: "long_run_check", ts: 1, processes }, core)
    assertStringIncludes(effectsOfType(action, "send_text_to_claude")[0].text, ">2 min (make, 3m00s)")
    writeConfig({})
})

Deno.test("long-run: every snapshot tick asks for a long-run check", () => {
    const action = snapshot({ type: "screen_snapshot_tick", ts: 7 }, { chatSessions: {} })
    assert(action.followUpEvents.some((event) => event.type === "long_run_check" && event.ts === 7))
})
