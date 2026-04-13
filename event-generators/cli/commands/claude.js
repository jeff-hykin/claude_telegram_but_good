// ---------------------------------------------------------------------------
// cbg claude — the JS reimplementation of the bash claude shim.
//
// The bash shim at $PATH/claude is now a 3-line delegator that exec's
// `cbg claude "$@"`. This file is what that delegator lands in. It does
// the same work as the old bash (see event-generators/cli/shim-setup.js
// shimScript() in prior versions), but in JS where we can reuse the
// pinned imports, lib/paths.js, and lib/logging.js instead of duplicating
// filename literals and passing data through env vars.
//
// Steps, in order:
//   1. Locate the real claude binary via findClaudeBinary() (skips the
//      installed shim so we don't loop forever).
//   2. Read paths.PERMISSION_ARGS_FILE (if present) for extra args to
//      inject on interactive invocations.
//   3. Feed argv + permArgs to the pure parser in
//      lib/pure/claude-shim-args.js → get a decision.
//   4. For `notele` and `passthrough`: spawn the real binary with the
//      parser-returned args and inherit stdio — no channels, no dtach.
//   5. For `interactive`: if dtach is missing, warn and fall back to a
//      direct exec with channels injected; otherwise wrap in
//      `dtach -c <sock> -z` and tee combined output to dtachLogFile()
//      exactly like the old bash shim (peek reads that log file).
//
// This command is NOT listed in `cbg --help` on purpose: it's a
// shim-internal entry point, not something users should call directly.
// ---------------------------------------------------------------------------

import { versionedImport } from "../../../lib/version.js"

const { dbg } = await versionedImport("../../../lib/logging.js", import.meta)
const { paths } = await versionedImport("../../../lib/paths.js", import.meta)
const { parseClaudeShimArgs } = await versionedImport("../../../lib/pure/claude-shim-args.js", import.meta)

// Duplicate of SHIM_MARKER from event-generators/cli/shim-setup.js.
// Kept local to avoid an import cycle (shim-setup.js doesn't export it)
// and because this file's correctness is tied to recognizing its OWN
// shim's marker string — not a general-purpose constant.
const SHIM_MARKER = "# __CBG_SHIM__"

export async function runClaude(args) {
    const resolved = resolveRealClaude()
    if (!resolved) {
        const pathEnv = Deno.env.get("PATH") ?? "(unset)"
        console.error("cbg claude: could not find Claude Code on PATH.")
        console.error("  Neither _claude_before_cbg nor a non-shim `claude` is reachable.")
        console.error("  Install Claude Code first (https://docs.claude.com/en/docs/claude-code),")
        console.error("  then run: cbg reinstall")
        console.error(`  PATH=${pathEnv}`)
        Deno.exit(127)
    }
    const realClaude = resolved

    let permArgs = ""
    try {
        permArgs = Deno.readTextFileSync(paths.PERMISSION_ARGS_FILE).trim()
    } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) {
            dbg("CBG-CLAUDE", "read permission_args:", e)
        }
    }

    const parsed = parseClaudeShimArgs(args, { permArgs })
    dbg("CBG-CLAUDE", `mode=${parsed.mode} inject=${JSON.stringify(parsed.injectArgs)} user=${JSON.stringify(parsed.userArgs)}`)

    if (parsed.mode === "notele" || parsed.mode === "passthrough") {
        const child = new Deno.Command(realClaude, {
            args: [...parsed.injectArgs, ...parsed.userArgs],
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
        }).spawn()
        const status = await child.status
        Deno.exit(status.code ?? 0)
        return
    }

    const argsForClaude = [...parsed.injectArgs, ...parsed.userArgs]

    if (!hasDtachOnPath()) {
        console.error("cbg claude: 'dtach' not found on PATH. /peek, /cancel, /pause, /resume won't work.")
        console.error("  Install with one of:")
        console.error("    brew install dtach")
        console.error("    apt-get install dtach")
        console.error("    nix profile install nixpkgs#dtach")
        console.error("  Continuing without dtach...")
        const child = new Deno.Command(realClaude, {
            args: argsForClaude,
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
        }).spawn()
        const status = await child.status
        Deno.exit(status.code ?? 0)
        return
    }

    const sockId = randomHex6()
    const sock = paths.dtachSockFile(sockId)
    const log = paths.dtachLogFile(sockId)

    try {
        Deno.mkdirSync(paths.STATE_DIR, { recursive: true })
    } catch (e) {
        dbg("CBG-CLAUDE", "mkdir STATE_DIR:", e)
    }

    try {
        Deno.writeTextFileSync(paths.NEXT_SESSION_FILE, JSON.stringify({ dtachSocket: sock }) + "\n")
    } catch (e) {
        dbg("CBG-CLAUDE", "write next_session.json:", e)
    }

    const env = {
        ...Deno.env.toObject(),
        CBG_DTACH: "1",
        CBG_DTACH_SOCKET: sock,
        CBG_DTACH_LOG: log,
    }

    // Replicate the old bash exactly:
    //   dtach -c "$SOCK" -z "$REAL" $EXTRA_ARGS "$@" 2>&1 | tee "$LOG"
    // Using sh -c with "$@" so user args with spaces/quotes pass through
    // intact — we don't have to re-escape them.
    const shellScript = '"$@" 2>&1 | tee "$CBG_DTACH_LOG"'
    const dtachArgv = ["dtach", "-c", sock, "-z", realClaude, ...argsForClaude]

    const child = new Deno.Command("sh", {
        args: ["-c", shellScript, "cbg-claude", ...dtachArgv],
        env,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
    }).spawn()
    const status = await child.status
    Deno.exit(status.code ?? 0)
}

function hasDtachOnPath() {
    try {
        const r = new Deno.Command("sh", {
            args: ["-c", "command -v dtach"],
            stdout: "null",
            stderr: "null",
        }).outputSync()
        return r.success
    } catch (e) {
        dbg("CBG-CLAUDE", "dtach check threw:", e)
        return false
    }
}

/**
 * Figure out what binary `cbg claude` should actually exec.
 *
 * Preference order:
 *   1. `_claude_before_cbg` if it's a command on PATH. This is the
 *      normal case: installShim() renamed the real claude to this name
 *      in the same bin dir, and since the bin dir is on PATH, so is
 *      the renamed file.
 *   2. `claude` as a silent fallback — BUT only if it's not our own
 *      shim. If a user's install is half-broken (backup deleted, or
 *      cbg uninstall ran mid-crash) we'd rather transparently call
 *      whatever real `claude` they have than fail. Detecting our own
 *      shim is critical: exec'ing it would recurse `cbg claude -> sh
 *      shim -> cbg claude -> ...` forever.
 *
 * Returns the resolved absolute path, or null if nothing usable was
 * found. The caller prints the error — we stay quiet here so the
 * dtach wrapper path can log via dbg() instead of stderr.
 */
function resolveRealClaude() {
    const backup = whichCmd("_claude_before_cbg")
    if (backup && fileExists(backup)) {
        dbg("CBG-CLAUDE", `using _claude_before_cbg at ${backup}`)
        return backup
    }

    const claudeCmd = whichCmd("claude")
    if (claudeCmd && fileExists(claudeCmd) && !isOurShim(claudeCmd)) {
        dbg("CBG-CLAUDE", `falling back to claude at ${claudeCmd} (_claude_before_cbg not found)`)
        return claudeCmd
    }

    return null
}

function whichCmd(name) {
    try {
        const r = new Deno.Command("sh", {
            args: ["-c", `command -v -- "${name}"`],
            stdout: "piped",
            stderr: "null",
        }).outputSync()
        if (!r.success) { return null }
        const s = new TextDecoder().decode(r.stdout).trim()
        return s || null
    } catch (e) {
        dbg("CBG-CLAUDE", `whichCmd(${name}) threw:`, e)
        return null
    }
}

function fileExists(path) {
    try {
        Deno.statSync(path)
        return true
    } catch {
        return false
    }
}

function isOurShim(path) {
    try {
        const content = Deno.readTextFileSync(path)
        return content.includes(SHIM_MARKER)
    } catch {
        // Binary file or unreadable — definitely not our sh shim.
        return false
    }
}

function randomHex6() {
    const bytes = new Uint8Array(3)
    crypto.getRandomValues(bytes)
    let s = ""
    for (const b of bytes) {
        s += b.toString(16).padStart(2, "0")
    }
    return s
}
