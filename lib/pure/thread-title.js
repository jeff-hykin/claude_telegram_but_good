/**
 * Thread title utilities — sanitization and validation for
 * cross-platform topic/thread names.
 *
 * Pure functions, no imports.
 */

const MAX_THREAD_TITLE_LENGTH = 128
const RESERVED_TITLES = new Set(["general"])

/**
 * Sanitize a thread title to the common denominator constraints:
 * - Max 128 chars
 * - No empty/whitespace-only
 * - "General" is reserved
 *
 * Returns the sanitized title, or null if invalid.
 */
export function sanitizeThreadTitle(raw) {
    if (typeof raw !== "string") { return null }
    const trimmed = raw.trim()
    if (trimmed.length === 0) { return null }
    if (RESERVED_TITLES.has(trimmed.toLowerCase())) { return null }
    if (trimmed.length > MAX_THREAD_TITLE_LENGTH) {
        return trimmed.slice(0, MAX_THREAD_TITLE_LENGTH)
    }
    return trimmed
}

/**
 * Check if a title would collide with an existing one in the map.
 * Returns a de-duped variant if collision found.
 */
export function dedupeTitle(title, existingTitles) {
    if (!existingTitles.includes(title)) { return title }
    for (let i = 2; i <= 99; i++) {
        const candidate = `${title}${i}`
        if (!existingTitles.includes(candidate)) { return candidate }
    }
    return `${title}${Date.now()}`
}
