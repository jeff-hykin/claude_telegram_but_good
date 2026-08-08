/**
 * lib/output-replace.js — find-and-replace applied to text on its way OUT
 * to Telegram (the mirror of lib/scrub.js, which rewrites text on its way
 * to disk).
 *
 * Rules live as JSON at $CBG_DIR/output-replace-rules.json — plain, not
 * base64 like scrub's, because these aren't secrets and are meant to be
 * hand-editable. Read fresh from disk on every call so edits take effect
 * without a reload.
 *
 * Matching is literal and case-SENSITIVE: replacing "the" should not also
 * rewrite "The" (and silently lowercase it).
 */

import { join } from "../imports.js"
import { versionedImport } from "./version.js"

const { paths } = await versionedImport("./paths.js", import.meta)

function rulesPath() {
    return join(paths.CBG_DIR, "output-replace-rules.json")
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
            Deno.stderr.writeSync(new TextEncoder().encode(`[OUTPUT-REPLACE] failed to load rules: ${e}\n`))
        }
        return []
    }
}

export function saveRules(rules) {
    Deno.writeTextFileSync(rulesPath(), `${JSON.stringify(rules, null, 4)}\n`)
}

/**
 * Apply every rule, in order, to a string. Non-strings pass through.
 */
export function applyOutputReplace(text) {
    if (typeof text !== "string" || text.length === 0) {
        return text
    }
    const rules = loadRules()
    let result = text
    for (const rule of rules) {
        result = result.replaceAll(rule.find, rule.replace)
    }
    return result
}

/**
 * Parse `<find> <replace>` out of a command's argument text. Either side
 * may be quoted so it can contain spaces or be empty ("" deletes matches).
 * Unquoted, the first whitespace-separated token is the find.
 */
export function parseFindReplace(text) {
    const args = []
    let remaining = (text ?? "").trim()
    for (let index = 0; index < 2; index++) {
        if (remaining.length === 0) {
            break
        }
        const quote = remaining[0]
        if (quote === '"' || quote === "'") {
            const end = remaining.indexOf(quote, 1)
            if (end < 0) {
                args.push(remaining.slice(1))
                remaining = ""
            } else {
                args.push(remaining.slice(1, end))
                remaining = remaining.slice(end + 1).trim()
            }
        } else if (index === 0) {
            const spaceIndex = remaining.indexOf(" ")
            if (spaceIndex < 0) {
                args.push(remaining)
                remaining = ""
            } else {
                args.push(remaining.slice(0, spaceIndex))
                remaining = remaining.slice(spaceIndex + 1).trim()
            }
        } else {
            args.push(remaining)
            remaining = ""
        }
    }
    return args
}
