// ---------------------------------------------------------------------------
// lib/pure/ids.js — identifier generators.
//
// Pure, no I/O, no versionedImport. Every function here produces some kind
// of identifier:
//
//   - `randomHex(bytes)` — crypto-random hex string; OTPs, request IDs,
//     temp-file suffixes.
//   - `generateName()` — PascalCase `<Adjective><Animal>` like "CalmLion",
//     used for human-friendly Telegram session names. MUST be regex-safe
//     under `[a-zA-Z0-9_]+` because `/switch_<id>` / `/chat_<id>` parsing
//     in lib/event-handlers/telegram-user.js uses that pattern — so the
//     output is defensively stripped of any non-alphanumeric characters
//     the underlying dictionary might someday introduce.
//   - `slugify(title)` — PascalCase slug of a free-form title, used as the
//     stable prefix of a long-task id.
//   - `generateTaskId(title)` — `slugify(title) + randomHex(2)`, the full
//     long-task id that combines readability with a short uniqueness tag.
//
// Previously these lived in three separate files (random.js, names.js,
// long-task-util.js). They've been consolidated here because `generateTaskId`
// already depends on `randomHex` and none of the four needs hot-reload —
// they're all pure functions of their inputs.
// ---------------------------------------------------------------------------

import { uniqueNamesGenerator, nameAdjectives, nameAnimals } from "../../imports.js"

/**
 * Return `bytes * 2` lowercase hex characters of cryptographic randomness.
 *
 * @param {number} bytes — how many random bytes to produce
 * @returns {string}
 */
export function randomHex(bytes) {
    const arr = new Uint8Array(bytes)
    crypto.getRandomValues(arr)
    return Array.from(arr, b => b.toString(16).padStart(2, "0")).join("")
}

/**
 * Produce a PascalCase `<Adjective><Animal>` name like "CalmLion",
 * "SwiftFox", or "BraveWolf" using the unique-names-generator dictionaries.
 *
 * Any non-alphanumeric character the library might emit (dash, space,
 * apostrophe, whatever future versions of the dictionary include) is
 * stripped defensively. This keeps the output compatible with the
 * `[a-zA-Z0-9_]+` regex in telegram-user.js's `/switch_<id>` and
 * `/chat_<id>` command dispatch — if a session id ever contained a dash,
 * those regexes would match only the prefix and the command would silently
 * target the wrong session.
 *
 * Guarantees:
 *   - matches /^[A-Z][a-zA-Z0-9]+$/
 *   - contains no dashes, underscores, spaces, or punctuation
 *   - first character is uppercase (PascalCase, not camelCase)
 */
export function generateName() {
    // `capital` style + empty separator asks the library for PascalCase
    // ("CalmLion"). We then strip any non-alphanumeric characters the
    // dictionary might have snuck in.
    const raw = uniqueNamesGenerator({
        dictionaries: [nameAdjectives, nameAnimals],
        style: "capital",
        separator: "",
        length: 2,
    })
    const clean = raw.replace(/[^a-zA-Z0-9]/g, "")
    // If the library ever produces an all-lowercase result (future style
    // change?), force the first char to uppercase so the PascalCase
    // contract holds.
    return clean.length > 0 && /[a-z]/.test(clean[0])
        ? clean[0].toUpperCase() + clean.slice(1)
        : clean
}

/**
 * Slugify a free-form task title into a PascalCase, alphanumeric-only
 * identifier. Punctuation is stripped, words are joined with an initial
 * capital each, and the result is truncated to 30 characters.
 *
 * Examples:
 *   "fix the auth migration so all tests pass"
 *     → "FixTheAuthMigrationSoAllTests"   (30 char clip)
 *   "build CLI v2!"
 *     → "BuildCliV2"
 *   ""              → ""
 *   "!!! ???"       → ""
 */
export function slugify(title) {
    return String(title ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .map(word => word.replace(/[^a-zA-Z0-9]/g, ""))
        .filter(Boolean)
        .map(word => word[0].toUpperCase() + word.slice(1).toLowerCase())
        .join("")
        .slice(0, 30)
}

/**
 * Generate a unique task id of the form `${slug}${4 hex chars}`.
 *
 * The hex suffix is 2 random bytes (4 hex chars). If the slug ends up empty
 * (e.g. punctuation-only title), we fall back to "Task" so the id is still
 * readable.
 */
export function generateTaskId(title) {
    const slug = slugify(title) || "Task"
    return `${slug}${randomHex(2)}`
}
