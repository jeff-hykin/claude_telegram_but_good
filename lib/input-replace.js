/**
 * lib/input-replace.js — find-and-replace applied to the user's Telegram
 * text on its way IN to a session (the mirror of lib/output-replace.js).
 *
 * Rules live as JSON at $CBG_DIR/input-replace-rules.json, read fresh from
 * disk on every call so edits take effect without a reload.
 *
 * Every rule matches as a whole word, case-insensitively: these are
 * shorthands typed on a phone ("idu"), so "IDU" should expand too, but
 * "fidu" or "idus" must not.
 */

import { join } from "../imports.js"
import { versionedImport } from "./version.js"

const { paths } = await versionedImport("./paths.js", import.meta)

function rulesPath() {
    return join(paths.CBG_DIR, "input-replace-rules.json")
}

export function loadRules() {
    try {
        const rules = JSON.parse(Deno.readTextFileSync(rulesPath()))
        if (!Array.isArray(rules)) {
            return []
        }
        return rules.filter((rule) => rule && typeof rule.find === "string" && rule.find.length > 0 && typeof rule.replace === "string")
    } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) {
            Deno.stderr.writeSync(new TextEncoder().encode(`[INPUT-REPLACE] failed to load rules: ${e}\n`))
        }
        return []
    }
}

export function saveRules(rules) {
    Deno.writeTextFileSync(rulesPath(), `${JSON.stringify(rules, null, 4)}\n`)
}

function wholeWordPattern(find) {
    const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "giu")
}

/**
 * Apply every rule, in order, to a string. Non-strings pass through.
 */
export function applyInputReplace(text) {
    if (typeof text !== "string" || text.length === 0) {
        return text
    }
    let result = text
    for (const rule of loadRules()) {
        result = result.replace(wholeWordPattern(rule.find), () => rule.replace)
    }
    return result
}
