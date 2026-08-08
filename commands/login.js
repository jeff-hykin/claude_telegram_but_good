// commands/login.js — drive Claude Code's /login from Telegram.
//
// Signing in is a terminal round-trip: the TUI prints an OAuth URL, you open
// it in a browser, and paste the resulting code back. From a phone you can't
// see the terminal, so this command runs the keystrokes for you, reads the
// URL off the session's screen, and sends it over Telegram. Paste the code
// back as the very next message and it gets typed in for you.
//
// The steps are chained through the timer queue as synthetic "/login __step"
// messages so each one re-enters the normal command pipeline — the waits are
// there because the TUI needs a moment to repaint between keystrokes.

import { readFileSync } from "node:fs"
import { versionedImport } from "../lib/version.js"
const { dbg } = await versionedImport("../lib/logging.js", import.meta)
const { renderTui } = await versionedImport("../lib/pure/tui-render.js", import.meta)
const { extractLoginUrl, loginTopicKey, looksLikeLoginCode } = await versionedImport("../lib/pure/login.js", import.meta)
const { sendEffect } = await versionedImport("../lib/pure/reply-to.js", import.meta)
const { resolveCommandSession, peekTimerEffect, selfMessageTimerEffect } = await versionedImport("../lib/command-session.js", import.meta)

export const tips = [
    "/login signs a session back in — it sends you the OAuth URL, then paste the code straight back.",
]

export const descriptions = {
    login: "Run /login in a session and relay the sign-in URL to you",
}

// How long the TUI takes to open a browser and paint the URL panel. Nothing
// else may be typed in the meantime: the panel lands directly on its "Paste
// code here" prompt, so a stray Enter submits an empty code and the TUI
// answers "Login interrupted".
const URL_RENDER_DELAY_MS = 3000

// The panel repaints in pieces, and a screen caught mid-repaint can show a
// half-drawn duplicate of one of the URL's rows. So a scrape only counts
// once two consecutive reads agree.
const RESCRAPE_DELAY_MS = 800
const MAX_SCRAPES = 8

// Same virtual screen peek uses, so the box art lines up the way it did on
// the real terminal.
const SCREEN_WIDTH = 80
const SCREEN_HEIGHT = 50
const LOG_HISTORY_LINES = 3000

function readScreen(session) {
    const logPath = session.dtachSocket.replace(/\.sock$/, ".log")
    const rawLines = readFileSync(logPath, "utf8").split(/\r?\n/)
    const ingest = rawLines.slice(-LOG_HISTORY_LINES).join("\n")
    return renderTui(ingest, { width: SCREEN_WIDTH, height: SCREEN_HEIGHT, ansi: false, trim: true })
}

export const commands = {
    login: (event, core) => {
        const { action, session, replyTo } = resolveCommandSession(event, core, "cmd/login")
        if (action) { return action }

        const step = (event.text ?? "").replace(/^\/login(?:@\w+)?\s*/, "").trim()
        const topicKey = loginTopicKey(event.chatId, event.threadId)

        // The URL panel should be on screen by now — scrape it and hand it over.
        if (step === "__url") {
            let url = null
            try {
                url = extractLoginUrl(readScreen(session))
            } catch (e) {
                dbg("LOGIN", `reading screen for ${session.id} failed:`, e)
            }
            const previous = core.chatState?.loginScrape?.[topicKey]
            const scrapes = (previous?.scrapes ?? 0) + 1
            if (!url || url !== previous?.url) {
                if (scrapes < MAX_SCRAPES) {
                    return {
                        stateChanges: { chatState: { loginScrape: { [topicKey]: { url, scrapes } } } },
                        effects: [selfMessageTimerEffect(event, "/login __url", RESCRAPE_DELAY_MS, "login_url")],
                    }
                }
                if (!url) {
                    dbg("LOGIN", `gave up scraping a sign-in URL for ${session.id}`)
                    return {
                        stateChanges: { chatState: { loginScrape: { [topicKey]: undefined } } },
                        effects: [
                            sendEffect(replyTo, "Ran /login but couldn't find a sign-in URL on the screen. Check /peek — the TUI may be waiting on a different prompt."),
                            peekTimerEffect(event, "login"),
                        ],
                    }
                }
            }
            dbg("LOGIN", `found sign-in URL for ${session.id} after ${scrapes} scrapes`)
            return {
                stateChanges: {
                    chatState: {
                        loginScrape: { [topicKey]: undefined },
                        pendingLogin: { [topicKey]: { sessionId: session.id, armedAt: Date.now() } },
                    },
                },
                effects: [
                    // Plain text, unescaped: the effect sends without a
                    // parse_mode, and Telegram autolinks a bare URL.
                    sendEffect(replyTo, `Sign in here, then send me the code:\n\n${url}`),
                ],
            }
        }

        // "/login <code>" — the natural way to paste the code back, and the
        // one chat-user.js's bare-message capture doesn't see (it skips
        // anything that starts with a slash).
        if (looksLikeLoginCode(step)) {
            dbg("LOGIN", `typing pasted login code into session ${session.id}`)
            return {
                stateChanges: { chatState: { pendingLogin: { [topicKey]: undefined } } },
                effects: [
                    { type: "send_raw_input_to_claude", sessionId: session.id, text: step },
                    peekTimerEffect(event, "login", URL_RENDER_DELAY_MS),
                ],
            }
        }

        dbg("LOGIN", `starting login sequence on session ${session.id}`)
        return {
            stateChanges: { chatState: { loginScrape: { [topicKey]: undefined } } },
            effects: [
                { type: "send_raw_input_to_claude", sessionId: session.id, text: "/login" },
                selfMessageTimerEffect(event, "/login __url", URL_RENDER_DELAY_MS, "login_url"),
            ],
        }
    },
}
