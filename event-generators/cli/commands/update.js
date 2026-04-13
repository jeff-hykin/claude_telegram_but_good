// ---------------------------------------------------------------------------
// `cbg update [ref]` — fetch from origin, check out a ref in
// paths.LOCAL_REPO, then hot-reload the running daemon in place.
//
// Argument modes:
//   cbg update           → pick the largest version-shaped tag
//                          (v?\d+\.\d+\.\d+ ...) and check it out.
//   cbg update <ref>     → check out whatever `<ref>` names. The
//                          resolver tries, in order:
//                            1. refs/tags/<ref>   — explicit tag
//                            2. refs/remotes/origin/<ref> — branch
//                            3. <ref>             — raw SHA / other
//                          First match wins. For a branch, this
//                          resolves to origin's tip AFTER the fetch,
//                          so `cbg update main` always lands on the
//                          latest commit regardless of the local
//                          main's staleness.
//
// What this does NOT do:
//   - Touch the plugin or .mcp.json files (use `cbg reinstall` for that).
//   - Refresh the claude CLI shim at $PATH/claude.
//   - Start the daemon if it isn't running — if there's nothing to
//     reload, the new code on disk will be picked up on the next
//     regular `cbg start` / reboot regardless.
//
// `cbg reinstall` covers the "everything" case. `cbg update` is the
// narrow "move my on-disk code to a specific ref" flow — the common
// case after a release-tag publish or when testing a branch.
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
 * (`latest`, `nightly`, `release-2026-04-12`) so `cbg update` without
 * an explicit ref only moves to actual releases. Anchored.
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

/**
 * True iff `git rev-parse --verify <candidate>^{commit}` succeeds.
 * Used to probe whether a user-supplied ref exists locally.
 */
function revParseCommit(candidate) {
    try {
        const { stdout } = gitInRepo(["rev-parse", "--verify", `${candidate}^{commit}`])
        return stdout.length > 0 ? stdout : null
    } catch (e) {
        dbg("UPDATE", `revParseCommit(${candidate}):`, e)
        return null
    }
}

/**
 * Resolve a user-supplied `ref` string to something git-checkout-able.
 * Tries tag → remote branch → raw ref in order. Returns
 * `{ kind, name, sha }` on success, null on failure.
 *
 *   kind: "tag" | "branch" | "ref"
 *   name: the canonical display name (e.g. "v1.2.3", "origin/main")
 *   sha:  the resolved commit SHA
 */
function resolveUserRef(ref) {
    // Tag first — explicit tag names win over branches with the same
    // name (tags are supposed to be immutable release markers; we
    // prefer them when they exist).
    const tagSha = revParseCommit(`refs/tags/${ref}`)
    if (tagSha) {
        return { kind: "tag", name: ref, sha: tagSha }
    }
    // Remote branch — resolves AFTER `git fetch` to origin's current
    // tip, not to the possibly-stale local branch.
    const remoteBranchSha = revParseCommit(`refs/remotes/origin/${ref}`)
    if (remoteBranchSha) {
        return { kind: "branch", name: `origin/${ref}`, sha: remoteBranchSha }
    }
    // Fallback: whatever the user gave (raw SHA, symbolic-ref, etc.).
    const raw = revParseCommit(ref)
    if (raw) {
        return { kind: "ref", name: ref, sha: raw }
    }
    return null
}

export async function runUpdate(args) {
    const userRef = args?.[0]  // optional — tag, branch, or SHA

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

    // ── Fetch from origin ──────────────────────────────────────────
    // `--tags` brings in every remote tag; the base fetch brings in
    // remote branches (so `origin/main` reflects the actual tip).
    // `--prune --prune-tags` drops refs that have been deleted
    // upstream so a branch-delete doesn't linger locally.
    console.log(c.dim("  Fetching from origin..."))
    try {
        gitInRepo(["fetch", "--tags", "--prune", "--prune-tags", "origin"])
        console.log(c.green("  \u2714 Fetched."))
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.log(c.yellow("  \u26A0 git fetch failed: " + msg))
        console.log(c.dim("    Cannot update without reaching the remote. Aborting."))
        Deno.exit(1)
    }

    // ── Resolve target ref ─────────────────────────────────────────
    let target   // { kind: "tag" | "branch" | "ref", name, sha }
    if (userRef) {
        target = resolveUserRef(userRef)
        if (!target) {
            console.log(
                c.yellow("  \u26A0 ") +
                "Could not resolve " + c.white(userRef) + " to any tag, remote branch, or revision.",
            )
            console.log(c.dim("    Check the name — `cbg update` accepts tag names, branch names, or SHAs."))
            Deno.exit(1)
        }
    } else {
        const tag = latestTag()
        if (!tag) {
            console.log(
                c.yellow("  \u26A0 ") +
                "No version-shaped tags in the upstream repo.",
            )
            console.log(c.dim("    Pass an explicit ref: `cbg update <tag-or-branch>`."))
            Deno.exit(1)
        }
        const sha = revParseCommit(`refs/tags/${tag}`)
        if (!sha) {
            console.log(c.yellow("  \u26A0 rev-parse failed for ") + c.white(tag))
            Deno.exit(1)
        }
        target = { kind: "tag", name: tag, sha }
    }

    // ── Already at that ref? ───────────────────────────────────────
    const currentSha = revParseCommit("HEAD")
    if (currentSha && currentSha === target.sha) {
        const label = target.kind === "tag"
            ? `${target.name}`
            : `${target.name} (${target.sha.slice(0, 10)})`
        console.log(
            c.green("  \u2714 Already on ") + c.white(label) + c.green(" — nothing to do."),
        )
        console.log()
        return
    }

    // ── Check out the resolved SHA ─────────────────────────────────
    // Always detach at the SHA. Branches checked out this way land
    // at a specific commit rather than tracking the local branch,
    // which is what we want for a daemon update: no stray merges,
    // no accidental divergence between local and origin/<branch>.
    // If the working tree has uncommitted changes git will refuse —
    // that's the right behavior, this CLI is not in the business of
    // stomping user edits.
    const shortSha = target.sha.slice(0, 10)
    const humanLabel = target.kind === "tag"
        ? target.name
        : `${target.name} @ ${shortSha}`
    console.log(c.dim("  Checking out ") + c.white(humanLabel) + c.dim("..."))
    try {
        gitInRepo(["checkout", "--detach", target.sha])
        console.log(c.green("  \u2714 Checked out ") + c.white(humanLabel) + c.green("."))
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
    console.log(c.green("  \u2714 Update complete (") + c.white(humanLabel) + c.green(")."))
    console.log()
}
