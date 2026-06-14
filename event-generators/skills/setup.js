// ---------------------------------------------------------------------------
// event-generators/skills/setup.js
//
// Install/remove the user-global skills cbg ships. Source of truth is the
// version-controlled <repo>/user-skills/<name>/ directory; we COPY each one
// into ~/.claude/skills/<name>/ at onboard/reinstall time so it's deployed
// per-machine (portable between systems via git + `cbg reinstall`).
//
// Why ~/.claude/skills and not the plugin's skills dir: worker sessions load
// the OFFICIAL telegram plugin's skills, not this repo's, and ~/.claude/skills
// is the one location EVERY claude session on the machine loads from (dtach
// workers + MCP-channel sessions alike). Copy (not symlink) because that's
// what the existing real skill dirs there are, and it avoids any uncertainty
// about whether Claude Code follows symlinked skill directories.
//
// Parallel to event-generators/hooks/setup.js and
// event-generators/mcp-server/setup.js.
// ---------------------------------------------------------------------------

import { versionedImport } from "../../lib/version.js"
import { join } from "../../imports.js"

const { dbg } = await versionedImport("../../lib/logging.js", import.meta)
const { paths } = await versionedImport("../../lib/paths.js", import.meta)

// Skills cbg ships. Each must exist as <repo>/user-skills/<name>/SKILL.md.
const USER_SKILLS = ["self_compact", "self_clear"]

function claudeSkillsDir() { return paths.CLAUDE_SKILLS_DIR }
function sourceDir(name) { return join(paths.LOCAL_REPO, "user-skills", name) }
function destDir(name) { return join(claudeSkillsDir(), name) }

// Recursively copy a directory tree. Skills are usually just a SKILL.md, but
// this handles references/ or scripts/ subdirs too.
function copyDirSync(src, dest) {
    Deno.mkdirSync(dest, { recursive: true })
    for (const entry of Deno.readDirSync(src)) {
        const s = join(src, entry.name)
        const d = join(dest, entry.name)
        if (entry.isDirectory) {
            copyDirSync(s, d)
        } else if (entry.isFile) {
            Deno.copyFileSync(s, d)
        }
        // Symlinks inside a skill source are not expected; skip them.
    }
}

/**
 * Copy every shipped user-skill from the repo into ~/.claude/skills/.
 * Idempotent: overwrites the destination each call so edits in the repo
 * deploy on the next `cbg reinstall`. Returns a per-skill result list.
 */
export function installUserSkills() {
    const results = []
    try {
        Deno.mkdirSync(claudeSkillsDir(), { recursive: true })
    } catch (e) {
        dbg("SKILLS", "mkdir skills dir failed:", e)
    }
    for (const name of USER_SKILLS) {
        const src = sourceDir(name)
        try {
            Deno.statSync(join(src, "SKILL.md"))
        } catch (e) {
            dbg("SKILLS", `source missing for ${name} (${src}):`, e)
            results.push({ name, ok: false, error: "source missing" })
            continue
        }
        try {
            // Remove any existing copy so deletions in the source propagate.
            try {
                Deno.removeSync(destDir(name), { recursive: true })
            } catch (e) {
                if (!(e instanceof Deno.errors.NotFound)) { dbg("SKILLS", `remove ${name}:`, e) }
            }
            copyDirSync(src, destDir(name))
            results.push({ name, ok: true })
        } catch (e) {
            dbg("SKILLS", `install ${name} failed:`, e)
            results.push({ name, ok: false, error: String(e) })
        }
    }
    return results
}

/**
 * Remove cbg's shipped user-skills from ~/.claude/skills/. Removes only the
 * cbg-owned skill names, so a user's unrelated skills are untouched.
 */
export function removeUserSkills() {
    for (const name of USER_SKILLS) {
        try {
            Deno.removeSync(destDir(name), { recursive: true })
        } catch (e) {
            if (!(e instanceof Deno.errors.NotFound)) { dbg("SKILLS", `remove ${name}:`, e) }
        }
    }
}
