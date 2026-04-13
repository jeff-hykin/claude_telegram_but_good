import { assertEquals, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { slugify, generateTaskId } from "../lib/pure/ids.js"

Deno.test("slugify: basic multi-word title", () => {
    // 30-char clip lands mid-"Pass": "FixTheAuthMigrationSoAllTestsP".
    assertEquals(
        slugify("fix the auth migration so all tests pass"),
        "FixTheAuthMigrationSoAllTestsP",
    )
})

Deno.test("slugify: single lowercase word", () => {
    assertEquals(slugify("debug"), "Debug")
})

Deno.test("slugify: punctuation is stripped", () => {
    assertEquals(slugify("build CLI v2!"), "BuildCliV2")
})

Deno.test("slugify: numbers are kept", () => {
    assertEquals(slugify("upgrade to deno 2 release"), "UpgradeToDeno2Release")
})

Deno.test("slugify: hyphenated words split into separate camels", () => {
    // hyphens are not whitespace, so the whole token survives stripping;
    // each word becomes one PascalCase chunk.
    assertEquals(slugify("fix auth-migration bug"), "FixAuthmigrationBug")
})

Deno.test("slugify: empty input → empty string", () => {
    assertEquals(slugify(""), "")
})

Deno.test("slugify: whitespace-only input → empty string", () => {
    assertEquals(slugify("    \t\n   "), "")
})

Deno.test("slugify: punctuation-only input → empty string", () => {
    assertEquals(slugify("!!! ??? ..."), "")
})

Deno.test("slugify: null/undefined → empty string", () => {
    assertEquals(slugify(null), "")
    assertEquals(slugify(undefined), "")
})

Deno.test("slugify: clipped to 30 chars max", () => {
    const out = slugify(
        "this is a very long title that absolutely will not fit in thirty characters",
    )
    assertEquals(out.length, 30)
    assertEquals(out, "ThisIsAVeryLongTitleThatAbsolu")
})

Deno.test("generateTaskId: shape is slug + 4 hex chars", () => {
    const id = generateTaskId("fix the auth migration")
    // Slug "FixTheAuthMigration" + 4 hex chars
    assertMatch(id, /^FixTheAuthMigration[0-9a-f]{4}$/)
})

Deno.test("generateTaskId: empty title falls back to Task", () => {
    const id = generateTaskId("")
    assertMatch(id, /^Task[0-9a-f]{4}$/)
})

Deno.test("generateTaskId: punctuation-only title falls back to Task", () => {
    const id = generateTaskId("!!! ???")
    assertMatch(id, /^Task[0-9a-f]{4}$/)
})

Deno.test("generateTaskId: produces unique-ish ids", () => {
    const a = generateTaskId("same title")
    const b = generateTaskId("same title")
    // Same slug, but the 4-hex suffix should differ basically always.
    assertEquals(a.slice(0, -4), b.slice(0, -4))
    // 4 hex chars = 65536 possibilities; collision in 1 trial is ~0%.
    if (a === b) {
        throw new Error(`generateTaskId collision (rare): ${a}`)
    }
})
