// ---------------------------------------------------------------------------
// lib/pure/claude-shim-args.js — pure arg parser for the `cbg claude` shim.
//
// Decides whether an incoming `claude ...` invocation should:
//   - be stripped of --no-tele and passed straight through to the real
//     claude binary (the escape hatch),
//   - be forwarded unchanged to the real binary (non-interactive
//     subcommands/flags like `claude mcp list`, `claude -p`, `claude -v`),
//   - or be treated as an interactive session that gets wrapped in dtach
//     with `--channels` and the configured permission args injected.
//
// Pure: no filesystem, no spawn — just string/array input → structured
// output. The runner at event-generators/cli/commands/claude.js handles
// the side effects.
// ---------------------------------------------------------------------------

const PASSTHROUGH_SUBCOMMANDS = new Set([
    "agents",
    "auth",
    "auto-mode",
    "doctor",
    "install",
    "mcp",
    "plugin",
    "plugins",
    "setup-token",
    "update",
    "upgrade",
])

const PASSTHROUGH_FLAGS = new Set([
    "-p",
    "--print",
    "-v",
    "--version",
    "-h",
    "--help",
])

/**
 * Parse a claude-cli argv array into a shim decision.
 *
 * @param {string[]} args       the user's argv (what follows `claude`)
 * @param {object}   ctx
 * @param {string}   ctx.permArgs   whitespace-separated contents of
 *     PERMISSION_ARGS_FILE (e.g. "--permission-mode all"), or empty string.
 *
 * @returns {{
 *   mode: "notele" | "passthrough" | "interactive",
 *   injectArgs: string[],
 *   userArgs: string[],
 * }}
 *   - `notele`: user asked for the escape hatch — userArgs is args with
 *     the leading --no-tele removed; injectArgs is empty.
 *   - `passthrough`: non-interactive invocation — userArgs is args unchanged;
 *     injectArgs is empty.
 *   - `interactive`: wrap in dtach. userArgs is args unchanged; injectArgs
 *     contains --channels (if not already present) and any configured
 *     permission args (if neither --permission-mode nor
 *     --dangerously-skip-permissions is already present).
 */
export function parseClaudeShimArgs(args, { permArgs = "" } = {}) {
    const argv = Array.isArray(args) ? args : []

    if (argv[0] === "--no-tele") {
        return {
            mode: "notele",
            injectArgs: [],
            userArgs: argv.slice(1),
        }
    }

    let passthrough = false
    if (argv.length > 0 && PASSTHROUGH_SUBCOMMANDS.has(argv[0])) {
        passthrough = true
    }
    if (!passthrough) {
        for (const arg of argv) {
            if (PASSTHROUGH_FLAGS.has(arg)) {
                passthrough = true
                break
            }
        }
    }

    if (passthrough) {
        return {
            mode: "passthrough",
            injectArgs: [],
            userArgs: argv.slice(),
        }
    }

    let hasChannels = false
    let hasPerm = false
    for (const arg of argv) {
        if (arg === "--channels") { hasChannels = true }
        if (arg === "--permission-mode" || arg === "--dangerously-skip-permissions") { hasPerm = true }
    }

    const injectArgs = []
    if (!hasChannels) {
        injectArgs.push("--channels", "plugin:telegram@claude-plugins-official")
    }
    if (!hasPerm && permArgs && permArgs.trim().length > 0) {
        for (const tok of permArgs.trim().split(/\s+/)) {
            if (tok.length > 0) {
                injectArgs.push(tok)
            }
        }
    }

    return {
        mode: "interactive",
        injectArgs,
        userArgs: argv.slice(),
    }
}
