// Tests for event-generators/skills/setup.js — installing/removing the
// user-global skills cbg ships into ~/.claude/skills.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, paths } from "./_helpers.js"
import { join } from "../imports.js"

setupTempPaths("cbg-skills-test-")

const { installUserSkills, removeUserSkills } = await import("../event-generators/skills/setup.js")

// Stage fake skill sources under <LOCAL_REPO>/user-skills/<name>/SKILL.md,
// matching the names setup.js ships (self_compact, self_clear).
function stageSources() {
    for (const name of ["self_compact", "self_clear"]) {
        const dir = join(paths.LOCAL_REPO, "user-skills", name)
        Deno.mkdirSync(dir, { recursive: true })
        Deno.writeTextFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\n---\nbody for ${name}\n`)
    }
}

function destSkill(name) {
    return join(paths.CLAUDE_DIR, "skills", name, "SKILL.md")
}

Deno.test("installUserSkills: copies shipped skills into ~/.claude/skills", () => {
    stageSources()
    const results = installUserSkills()
    assertEquals(results.filter((r) => r.ok).map((r) => r.name).sort(), ["self_clear", "self_compact"])
    assert(Deno.statSync(destSkill("self_compact")).isFile)
    assert(Deno.statSync(destSkill("self_clear")).isFile)
    assert(Deno.readTextFileSync(destSkill("self_compact")).includes("body for self_compact"))
})

Deno.test("installUserSkills: idempotent + reflects source edits on reinstall", () => {
    stageSources()
    installUserSkills()
    // Edit the source, reinstall, expect the dest to update.
    Deno.writeTextFileSync(
        join(paths.LOCAL_REPO, "user-skills", "self_compact", "SKILL.md"),
        "---\nname: self_compact\n---\nEDITED body\n",
    )
    installUserSkills()
    assert(Deno.readTextFileSync(destSkill("self_compact")).includes("EDITED body"))
})

Deno.test("installUserSkills: reports failure when a source is missing", () => {
    // Fresh temp root with NO staged sources.
    setupTempPaths("cbg-skills-test-missing-")
    const results = installUserSkills()
    assertEquals(results.every((r) => !r.ok), true)
})

Deno.test("removeUserSkills: deletes the installed skill dirs", () => {
    setupTempPaths("cbg-skills-test-remove-")
    stageSources()
    installUserSkills()
    assert(Deno.statSync(destSkill("self_compact")).isFile)
    removeUserSkills()
    let gone = false
    try {
        Deno.statSync(join(paths.CLAUDE_DIR, "skills", "self_compact"))
    } catch {
        gone = true
    }
    assert(gone, "self_compact skill dir should be removed")
})
