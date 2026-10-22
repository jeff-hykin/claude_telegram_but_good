/**
 * Pull the socket path out of a `dtach` process's argv.
 *
 * A session's dtach socket is the one piece of its identity that must be
 * ground truth: every reach-in (`/peek`, `/raw`, reply nudges, self-input)
 * types into it. cbg normally learns it from `state/next_session.json`, a
 * single slot that two overlapping spawns can cross-wire — so a session can
 * end up registered against another session's socket and silently lose every
 * nudge. Reading it back off the live dtach process settles it from the
 * kernel instead of from a file.
 *
 * dtach's own argv shape is `dtach <mode> <socket> [options] [command...]`,
 * where mode is one of -a/-A/-c/-n/-N (attach/create variants) or -p (push).
 * Option letters may be bundled (`-Ez`), so a token counts as the mode only
 * when it actually carries a mode letter.
 */

const MODE_LETTERS = /^-[^-]*[aAcnNp]/

/**
 * @param {string} args - full command line, e.g. `dtach -n /path/x.sock -Ez script ...`
 * @returns {string|null} the socket path, or null when argv isn't a dtach invocation
 */
export function parseDtachSocketFromArgs(args) {
    if (typeof args !== "string" || args.length === 0) { return null }
    const tokens = args.trim().split(/\s+/)
    if (!/^(?:\S*\/)?dtach$/.test(tokens[0] ?? "")) { return null }
    for (let i = 1; i < tokens.length; i++) {
        const token = tokens[i]
        if (!token.startsWith("-")) {
            // First bare word is the command to run, not a socket — dtach
            // was invoked without a mode flag (it would error), so give up
            // rather than guess.
            return null
        }
        if (MODE_LETTERS.test(token)) {
            const socket = tokens[i + 1]
            return socket && !socket.startsWith("-") ? socket : null
        }
    }
    return null
}
