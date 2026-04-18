// ---------------------------------------------------------------------------
// lib/pure/tui-prompt-detector.js
//
// Detects Claude Code TUI prompts that block the session and require
// user interaction. These are NOT MCP permission requests (those go
// through the channel/permission flow) — they're TUI-level dialogs
// rendered directly in the terminal.
//
// Known prompt types:
//   - file_create: "Do you want to create <file>?" (Yes/No/Yes+edit)
//   - trust_folder: "Do you want to trust this folder?" (handled
//     separately by refresh.js's watchForTrustPrompt, but detected
//     here as a fallback)
//
// Pure function: takes rendered screen text, returns detected prompts.
// No I/O, no state mutation.
// ---------------------------------------------------------------------------

/**
 * Strip ANSI escape sequences and control characters from raw terminal
 * output. Returns plain searchable text. This is more reliable than
 * TUI rendering for prompt detection because it doesn't depend on
 * correct VT100 emulation of the screen layout.
 */
export function stripAnsi(raw) {
    return raw
        .replace(/\x1b\[\d*C/g, " ")
        .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
        .replace(/\x1b\[[0-9;?]*[a-zA-Z~]/g, "")
        .replace(/\x1b[>=<]/g, "")
        .replace(/\x1b[()][0-9A-Za-z]/g, "")
        .replace(/\x1b./g, "")
        .replace(/[\x00-\x08\x0e-\x1f\x7f]/g, "")
}

/**
 * Scan ANSI-stripped raw terminal output for known TUI prompts.
 *
 * Works on raw dtach log text with ANSI stripped (via stripAnsi),
 * NOT on rendered screen text. This avoids dependence on the VT100
 * emulator producing correct layout — the raw text contains the
 * prompt strings verbatim even when rendering is garbled.
 *
 * @param {string} text — ANSI-stripped raw terminal text (tail of dtach log)
 * @returns {Array<{ type: string, file?: string, autoAnswer?: string }>}
 *   Detected prompts. `autoAnswer` is the keypress to inject if the
 *   prompt should be auto-resolved (e.g. "1" for "Yes").
 */
export function detectPrompts(text) {
    if (!text || typeof text !== "string") {
        return []
    }
    const prompts = []

    // "Do you want to create <filename>?"
    // Claude Code shows this when it wants to create a CLAUDE.md,
    // deno.json, tsconfig.json, etc. The TUI renders a numbered menu:
    //   Do you want to create foo.md?
    //    ❯ 1. Yes
    //      2. Yes, and allow Claude to edit ...
    //      3. No
    const createMatch = text.match(/Do you want to create ([^\n?]+)\?/i)
    if (createMatch) {
        prompts.push({
            type: "file_create",
            file: createMatch[1].trim(),
            // "1" selects "Yes" in the numbered menu
            autoAnswer: "1",
        })
    }

    // "Do you want to trust this folder?"
    // Usually handled by refresh.js's watchForTrustPrompt, but if
    // that missed it (e.g. timing), catch it here as a fallback.
    if (/trust this folder|trust this project|Yes,?\s*I\s*trust/i.test(text)) {
        prompts.push({
            type: "trust_folder",
            autoAnswer: "\n",
        })
    }

    // "Select a project" or "Which workspace" — Claude Code sometimes
    // asks which project to use when cwd has multiple candidates.
    if (/Select a project|Which workspace/i.test(text)) {
        prompts.push({
            type: "project_select",
            // Don't auto-answer — let the user decide
            autoAnswer: null,
        })
    }

    return prompts
}
