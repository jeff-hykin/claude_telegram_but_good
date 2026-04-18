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
 * Scan rendered screen text for known TUI prompts.
 *
 * @param {string} screenText — the rendered virtual screen (from
 *   tui-render.js or equivalent). ANSI stripped, plain text.
 * @returns {Array<{ type: string, file?: string, autoAnswer?: string }>}
 *   Detected prompts. `autoAnswer` is the keypress to inject if the
 *   prompt should be auto-resolved (e.g. "1\n" for "Yes").
 */
export function detectPrompts(screenText) {
    if (!screenText || typeof screenText !== "string") {
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
    const createMatch = screenText.match(/Do you want to create ([^\n?]+)\?/i)
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
    if (/trust this folder|trust this project|Yes,?\s*I\s*trust/i.test(screenText)) {
        // Only flag it if there's a visible prompt selector (❯) — if the
        // trust prompt was already answered, don't re-fire.
        if (/[❯>]\s*\d+\.\s*Yes/i.test(screenText) || /Yes,?\s*I\s*trust/i.test(screenText)) {
            prompts.push({
                type: "trust_folder",
                autoAnswer: "\n",
            })
        }
    }

    // "Select a project" or "Which workspace" — Claude Code sometimes
    // asks which project to use when cwd has multiple candidates.
    if (/Select a project|Which workspace/i.test(screenText)) {
        if (/[❯>]\s*\d+\./i.test(screenText)) {
            prompts.push({
                type: "project_select",
                // Don't auto-answer — let the user decide
                autoAnswer: null,
            })
        }
    }

    return prompts
}
