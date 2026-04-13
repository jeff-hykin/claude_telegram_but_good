// ---------------------------------------------------------------------------
// `cbg update` — fetch the latest released tag from the upstream repo,
// check it out in paths.LOCAL_REPO, then hot-reload the running daemon
// in place.
//
// What this does NOT do:
//   - Touch the plugin or .mcp.json files (use `cbg reinstall` for that).
//   - Refresh the claude CLI shim at $PATH/claude.
//   - Start the daemon if it isn't running — if there's nothing to
//     reload, the new code on disk will be picked up on the next
//     regular `cbg start` / reboot regardless.
//
// `cbg reinstall` covers the "everything" case. `cbg update` is the
// narrow "I want the latest upstream release without rebuilding the
// marketplace symlink or re-registering hooks" flow — the common
// case after a release-tag publish.
//
// Dev mode: if paths.LOCAL_REPO is a symlink (set by `CBG_DEV=... cbg
// onboard` during development), we REFUSE to touch it. A git
// checkout into a dev symlink would nuke the developer's working
// tree, and that's not something a CLI command should ever do
// silently. The command logs and exits with an error; `cbg reload`
// (which is what `reinstall` falls back to) is the right tool
// during development.
// ---------------------------------------------------------------------------

import { versionedImport } from "../../../lib/version.js"

const [
    { colors },
    { isDaemonRunning },
    { paths },
    { dbg },
    { hotReloadDaemon },
] = await Promise.all([
    versionedImport("../../../imports.js", import.meta),
    versionedImport("../../../lib/daemon.js", import.meta),
    versionedImport("../../../lib/paths.js", import.meta),
    versionedImport("../../../lib/logging.js", import.meta),
    versionedImport("../helpers.js", import.meta),
])
const c = colors

/**
 * Run `git` inside the local-repo checkout and return its captured
 * stdout/stderr. Throws on non-zero exit (with the collected output
 * folded into the error message) so callers can rely on the return
 * value being meaningful.
 */
function gitInRepo(args) {
    const result = new Deno.Command("git", {
        args: ["-C", paths.LOCAL_REPO, ...args],
        stdout: "piped",
        stderr: "piped",
    }).outputSync()
    const stdout = new TextDecoder().decode(result.stdout).trim()
    const stderr = new TextDecoder().decode(result.stderr).trim()
    if (!result.success) {
        const detail = stderr || stdout || `exit ${result.code}`
        throw new Error(`git ${args.join(" ")} failed: ${detail}`)
    }
    return { stdout, stderr }
}

/**
 * True iff paths.LOCAL_REPO is a symlink — i.e. a dev install done
 * via `CBG_DEV=/path/to/repo cbg onboard`. We refuse to git-checkout
 * through a dev symlink; the developer's working tree is sacrosanct.
 */
function isDevSymlink() {
    try {
        const lstat = Deno.lstatSync(paths.LOCAL_REPO)
        return lstat.isSymlink
    } catch (e) {
        // Not-found / permission error: not a symlink we can see.
        if (!(e instanceof Deno.errors.NotFound)) {
            dbg("UPDATE", "lstat LOCAL_REPO:", e)
        }
        return false
    }
}

/**
 * Match a version-like tag: `1.2.3`, `v1.2.3`, `1.2.3-rc1`,
 * `v2.0.0-beta.4`, etc. Rejects names that aren't version numbers
 * (`latest`, `nightly`, `release-2026-04-12`) so `cbg update` only
 * moves to actual releases. Whitespace-anchored.
 */
const VERSION_TAG = /^v?\d+\.\d+\.\d+(?:[-+.].+)?$/

/**
 * Pick the "latest" version tag. Strategy:
 *   1. Ask git for ALL tags, sorted newest-first by `-v:refname`
 *      (git's native semver-aware sort: v2.10.0 ranks above v2.9.0).
 *   2. Filter to names matching VERSION_TAG.
 *   3. Return the first survivor.
 *
 * If no version-shaped tags exist, return null — caller decides
 * what to do about it.
 */
function latestTag() {
    try {
        const { stdout } = gitInRepo([
            "for-each-ref",
            "--sort=-v:refname",
            "--format=%(refname:short)",
            "refs/tags",
        ])
        const names = stdout.split("\n").map(s => s.trim()).filter(Boolean)
        for (const name of names) {
            if (VERSION_TAG.test(name)) {
                return name
            }
        }
        return null
    } catch (e) {
        dbg("UPDATE", "latestTag:", e)
        return null
    }
}

export async function runUpdate(_args) {
    console.log()
    console.log(c.bold.white("  Updating cbg..."))
    console.log(c.dim("  " + "\u2500".repeat(40)))

    // ── Dev-symlink guard ──────────────────────────────────────────
    if (isDevSymlink()) {
        console.log(
            c.yellow("  \u26A0 ") +
            c.dim("paths.LOCAL_REPO is a symlink — this looks like a CBG_DEV install."),
        )
        console.log(
            c.dim("    ") +
            "Refusing to git-checkout through the symlink. Run `cbg reinstall` instead,",
        )
        console.log(
            c.dim("    ") +
            "or update your dev tree in place and then `cbg reload`.",
        )
        Deno.exit(1)
    }

    // ── Repo exists? ───────────────────────────────────────────────
    try {
        Deno.statSync(`${paths.LOCAL_REPO}/.git`)
    } catch (e) {
        if (e instanceof Deno.errors.NotFound) {
            console.log(
                c.yellow("  \u26A0 ") +
                "No local repo found at " + c.white(paths.LOCAL_REPO),
            )
            console.log(c.dim("    Run `cbg onboard` first, or `cbg reinstall` to clone fresh."))
        } else {
            console.log(c.yellow("  \u26A0 statSync failed: " + e))
        }
        Deno.exit(1)
    }

    // ── Fetch tags from origin ─────────────────────────────────────
    console.log(c.dim("  Fetching tags from origin..."))
    try {
        gitInRepo(["fetch", "--tags", "--prune", "--prune-tags", "origin"])
        console.log(c.green("  \u2714 Fetched."))
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.log(c.yellow("  \u26A0 git fetch failed: " + msg))
        console.log(c.dim("    Cannot update without reaching the remote. Aborting."))
        Deno.exit(1)
    }

    // ── Resolve latest tag ─────────────────────────────────────────
    const tag = latestTag()
    if (!tag) {
        console.log(
            c.yellow("  \u26A0 ") +
            "No tags found in the upstream repo.",
        )
        console.log(c.dim("    Nothing to check out. Use `cbg reinstall` for a tip-of-branch update."))
        Deno.exit(1)
    }

    // ── Already at that tag? ───────────────────────────────────────
    let currentSha
    try { currentSha = gitInRepo(["rev-parse", "HEAD"]).stdout } catch (e) { dbg("UPDATE", "rev-parse HEAD:", e); currentSha = "" }
    let tagSha
    try { tagSha = gitInRepo(["rev-parse", tag]).stdout } catch (e) { dbg("UPDATE", "rev-parse tag:", e); tagSha = "" }

    if (currentSha && currentSha === tagSha) {
        console.log(
            c.green("  \u2714 Already on ") + c.white(tag) + c.green(" — nothing to do."),
        )
        console.log()
        return
    }

    // ── Check out the tag ──────────────────────────────────────────
    console.log(c.dim("  Checking out ") + c.white(tag) + c.dim("..."))
    try {
        // Detach cleanly; if the working tree has uncommitted changes
        // git will refuse, which is the right behavior — this CLI is
        // not in the business of stomping user edits.
        gitInRepo(["checkout", "--detach", tag])
        console.log(c.green("  \u2714 Checked out ") + c.white(tag) + c.green("."))
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.log(c.yellow("  \u26A0 git checkout failed: " + msg))
        console.log(c.dim("    Your local tree may have uncommitted changes. Investigate and re-run."))
        Deno.exit(1)
    }

    // ── Hot-reload the running daemon (if any) ─────────────────────
    if (isDaemonRunning()) {
        console.log(c.dim("  Daemon is running — hot-reloading in place..."))
        try {
            const reply = await hotReloadDaemon()
            if (reply?.ok) {
                console.log(
                    c.green("  \u2714 Hot reload complete — daemon now at cbgVersion ") +
                    c.white(String(reply.version)) + c.green("."),
                )
                console.log(c.dim("    Connected shims pick up new code on their next tool call."))
            } else {
                console.log(c.yellow("  \u26A0 Hot reload returned: " + JSON.stringify(reply)))
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            console.log(c.yellow("  \u26A0 Hot reload failed: " + msg))
            console.log(c.dim("    Run `cbg restart` to apply disk changes via a hard restart."))
        }
    } else {
        console.log(
            c.dim("  Daemon is not running — new code will be picked up on next `cbg start`."),
        )
    }

    console.log()
    console.log(c.green("  \u2714 Update complete (") + c.white(tag) + c.green(")."))
    console.log()
}
