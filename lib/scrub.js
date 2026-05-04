/**
 * lib/scrub.js — find-and-replace scrubbing for text before it hits disk.
 *
 * Rules are stored as a base64-encoded JSON array at $CBG_DIR/scrub-rules.b64.
 * Each rule: { find: "string", replace: "string" }.
 *
 * The base64 encoding is intentional — just enough indirection that greps
 * for the sensitive terms won't find them in the rules file.
 *
 * Rules are read fresh from disk on every call (same pattern as config-manager)
 * so edits take effect immediately without a restart.
 */

import { join } from "../imports.js"
import { versionedImport } from "./version.js"

const { paths } = await versionedImport("./paths.js", import.meta)

function rulesPath() {
    return join(paths.CBG_DIR, "scrub-rules.b64")
}

/**
 * Load the current scrub rules from disk.
 * Returns [] if the file doesn't exist or can't be parsed.
 */
export function loadRules() {
    try {
        const raw = Deno.readTextFileSync(rulesPath())
        const json = atob(raw.trim())
        const rules = JSON.parse(json)
        if (!Array.isArray(rules)) {
            return []
        }
        return rules.filter(r => r && typeof r.find === "string" && typeof r.replace === "string")
    } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) {
            // Log to stderr only — can't use dbg() here (circular dep risk)
            Deno.stderr.writeSync(new TextEncoder().encode(`[SCRUB] failed to load rules: ${e}\n`))
        }
        return []
    }
}

/**
 * Save rules to disk as base64-encoded JSON.
 */
export function saveRules(rules) {
    const json = JSON.stringify(rules)
    const b64 = btoa(json)
    Deno.writeTextFileSync(rulesPath(), b64)
}

/**
 * Apply all scrub rules to a string. Case-insensitive matching.
 * Returns the scrubbed string.
 */
export function scrubText(text) {
    if (typeof text !== "string") {
        return text
    }
    const rules = loadRules()
    if (rules.length === 0) {
        return text
    }
    let result = text
    for (const rule of rules) {
        // Case-insensitive global replace
        const escaped = rule.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        result = result.replace(new RegExp(escaped, "gi"), rule.replace)
    }
    return result
}

/**
 * Deep-walk an object and scrub all string values in place.
 * Returns a new object (does not mutate the original).
 */
export function scrubObject(obj) {
    if (obj === null || obj === undefined) {
        return obj
    }
    if (typeof obj === "string") {
        return scrubText(obj)
    }
    if (Array.isArray(obj)) {
        return obj.map(scrubObject)
    }
    if (typeof obj === "object") {
        const out = {}
        for (const [k, v] of Object.entries(obj)) {
            out[k] = scrubObject(v)
        }
        return out
    }
    return obj
}
