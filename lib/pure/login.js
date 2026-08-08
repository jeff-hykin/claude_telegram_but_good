// lib/pure/login.js — pure helpers for the /login flow.
//
// Claude Code's /login prints the sign-in URL inside a box-drawn panel, and
// the URL is far longer than the terminal is wide, so it arrives split
// across several rows with a border glyph on each side. Reassembling it
// means stripping the borders and re-joining the wrapped fragments.

// The whole Unicode Box Drawing block.
const BOX_GLYPHS = /[─-╿]/g

// Everything RFC 3986 allows in a URI, which is also the charset a wrapped
// continuation row is made of.
const URL_CHARS = /^[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/

// A wrapped fragment fills the box, so it's long. Requiring some length
// keeps a short unrelated word on the following row from being glued on.
const MIN_CONTINUATION_LENGTH = 20

// A row only continues onto the next one if it actually hit the right edge.
// A shorter row is where the URL ended, so anything below it is other panel
// text (or, mid-repaint, a half-drawn duplicate of an earlier row).
const WRAPPED_ROW_LENGTH = 40

/**
 * @param {string} screen  a rendered terminal screen (ANSI already stripped)
 * @returns {string|null}  the reassembled URL, or null if none was found
 */
export function extractLoginUrl(screen) {
    const lines = String(screen ?? "").split("\n").map((line) => line.replace(BOX_GLYPHS, " ").trim())
    // Search upward: a session can log in more than once, and the panel we
    // want is the bottom-most one. Searching downward also latches onto a
    // half-drawn row left over from a previous repaint.
    let head = -1
    for (let i = lines.length - 1; i >= 0; i--) {
        if (/https?:\/\//.test(lines[i])) {
            head = i
            break
        }
    }
    if (head < 0) { return null }
    // A URL can't contain whitespace, so the first gap ends this row's
    // fragment (the row may have trailing box padding).
    let fragment = lines[head].slice(lines[head].search(/https?:\/\//)).split(/\s/)[0]
    let url = fragment
    for (let j = head + 1; j < lines.length && fragment.length >= WRAPPED_ROW_LENGTH; j++) {
        fragment = lines[j]
        if (fragment.length < MIN_CONTINUATION_LENGTH || !URL_CHARS.test(fragment)) { break }
        url += fragment
    }
    return url
}

/**
 * Identifies which topic is mid-login, so the code the user pastes back is
 * routed to the session that asked for it.
 */
export function loginTopicKey(chatId, threadId) {
    return `${chatId}:${threadId ?? ""}`
}

// The value pasted back from the browser is normally an authorization code
// and its state parameter joined by "#". Some builds hand back the bare
// code, so accept that too — but only when it's long enough that ordinary
// prose can't be mistaken for it.
const CODE_WITH_STATE = /^[A-Za-z0-9._~-]{16,}#[A-Za-z0-9._~-]{8,}$/
const BARE_CODE = /^[A-Za-z0-9._~-]{24,}$/

export function looksLikeLoginCode(text) {
    const token = String(text ?? "").trim()
    return CODE_WITH_STATE.test(token) || BARE_CODE.test(token)
}
