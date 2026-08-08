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
const { extractLoginUrl, loginTopicKey, looksLikeLoginCode, isOpeningBrowser, awaitsLoginConfirm } = await versionedImport("../lib/pure/login.js", import.meta)
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

// Each scrape re-renders a whole virtual screen, which is too costly to keep
// up at 800ms for a minute, so the poll slows down once the quick case has
// clearly missed.
const FAST_SCRAPES = 12
const SLOW_RESCRAPE_DELAY_MS = 2500
const rescrapeDelay = (scrapes) => (scrapes < FAST_SCRAPES ? RESCRAPE_DELAY_MS : SLOW_RESCRAPE_DELAY_MS)

// Two separate clocks, because the two ways this stalls need different
// answers. `SCRAPE_BUDGET_MS` covers a screen that shows nothing at all —
// /login was queued behind a running turn, say. `SCRAPE_HARD_LIMIT_MS` is
// the ceiling for a TUI that keeps telling us it's still opening a browser,
// which on a cold Firefox start really can take most of a minute.
const SCRAPE_BUDGET_MS = 45_000
const SCRAPE_HARD_LIMIT_MS = 180_000

// Typing the code is slow and the token exchange is a network round-trip, so
// the confirmation panel is a couple of seconds out at best.
const CONFIRM_DELAY_MS = 2000
const CONFIRM_POLL_MS = 800
const CONFIRM_BUDGET_MS = 30_000

// How long a sent-but-unanswered URL stays live. Past this the user has
// almost certainly abandoned that attempt, so /login starts a fresh one
// instead of repeating a URL whose OAuth state has expired anyway.
const PENDING_LOGIN_TTL_MS = 10 * 60 * 1000

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

function screenOf(session) {
    try {
        return readScreen(session)
    } catch (e) {
        dbg("LOGIN", `reading screen for ${session.id} failed:`, e)
        return null
    }
}

export const commands = {
    login: (event, core) => {
        const { action, session, replyTo } = resolveCommandSession(event, core, "cmd/login")
        if (action) { return action }

        const step = (event.text ?? "").replace(/^\/login(?:@\w+)?\s*/, "").trim()
        const topicKey = loginTopicKey(event.chatId, event.threadId)
        const now = Date.now()

        // The URL panel should be on screen by now — scrape it and hand it over.
        if (step === "__url") {
            const previous = core.chatState?.loginScrape?.[topicKey]
            const screen = screenOf(session)
            const url = screen === null ? null : extractLoginUrl(screen)
            const scrapes = (previous?.scrapes ?? 0) + 1

            const hardDeadline = previous?.hardDeadline ?? (now + SCRAPE_HARD_LIMIT_MS)
            let deadline = previous?.deadline ?? (now + SCRAPE_BUDGET_MS)
            // The TUI is still working, so the silence isn't evidence of
            // anything — hold the deadline open (up to the hard ceiling).
            if (isOpeningBrowser(screen)) {
                deadline = Math.min(hardDeadline, Math.max(deadline, now + SCRAPE_BUDGET_MS))
            }

            const settled = url && url === previous?.url
            const expired = now >= deadline || now >= hardDeadline
            if (!settled && !expired) {
                return {
                    stateChanges: { chatState: { loginScrape: { [topicKey]: { url, scrapes, deadline, hardDeadline } } } },
                    effects: [selfMessageTimerEffect(event, "/login __url", rescrapeDelay(scrapes), "login_url")],
                }
            }
            if (!url) {
                dbg("LOGIN", `gave up scraping a sign-in URL for ${session.id} after ${scrapes} scrapes`)
                return {
                    stateChanges: { chatState: { loginScrape: { [topicKey]: undefined } } },
                    effects: [
                        sendEffect(replyTo, "Ran /login but couldn't find a sign-in URL on the screen. Check /peek — the TUI may be waiting on a different prompt."),
                        peekTimerEffect(event, "login"),
                    ],
                }
            }
            dbg("LOGIN", `found sign-in URL for ${session.id} after ${scrapes} scrapes`)
            return {
                stateChanges: {
                    chatState: {
                        loginScrape: { [topicKey]: undefined },
                        pendingLogin: { [topicKey]: { sessionId: session.id, armedAt: now, url } },
                    },
                },
                effects: [
                    // Plain text, unescaped: the effect sends without a
                    // parse_mode, and Telegram autolinks a bare URL.
                    sendEffect(replyTo, `Sign in here, then send me the code:\n\n${url}`),
                ],
            }
        }

        // The code was accepted, and /login is now parked on "Login
        // successful. Press Enter to continue…". Nothing dismisses that on
        // its own, so the session never gets its prompt back — press Return
        // for it, but only once the panel is actually on screen, since a
        // blind Enter would land on whatever else the TUI is showing.
        if (step === "__confirm") {
            const previous = core.chatState?.loginConfirm?.[topicKey]
            const deadline = previous?.deadline ?? (now + CONFIRM_BUDGET_MS)
            const screen = screenOf(session)
            if (awaitsLoginConfirm(screen)) {
                dbg("LOGIN", `dismissing the sign-in confirmation for ${session.id}`)
                return {
                    stateChanges: { chatState: { loginConfirm: { [topicKey]: undefined } } },
                    effects: [
                        // Empty text, default submit: the panel wants a bare Return.
                        { type: "send_raw_input_to_claude", sessionId: session.id, text: "" },
                        peekTimerEffect(event, "login"),
                    ],
                }
            }
            if (now < deadline) {
                return {
                    stateChanges: { chatState: { loginConfirm: { [topicKey]: { deadline } } } },
                    effects: [selfMessageTimerEffect(event, "/login __confirm", CONFIRM_POLL_MS, "login_confirm")],
                }
            }
            dbg("LOGIN", `no sign-in confirmation appeared for ${session.id}`)
            return {
                stateChanges: { chatState: { loginConfirm: { [topicKey]: undefined } } },
                effects: [peekTimerEffect(event, "login")],
            }
        }

        // "/login <code>" — the natural way to paste the code back, and the
        // one chat-user.js's bare-message capture doesn't see (it skips
        // anything that starts with a slash).
        if (looksLikeLoginCode(step)) {
            dbg("LOGIN", `typing pasted login code into session ${session.id}`)
            return {
                stateChanges: { chatState: { pendingLogin: { [topicKey]: undefined }, loginConfirm: { [topicKey]: undefined } } },
                effects: [
                    { type: "send_raw_input_to_claude", sessionId: session.id, text: step },
                    selfMessageTimerEffect(event, "/login __confirm", CONFIRM_DELAY_MS, "login_confirm"),
                ],
            }
        }

        // A round-trip already in flight is the one case where running
        // /login again actively hurts: the panel sits on its "Paste code
        // here" prompt, so the second "/login" gets typed in as the code.
        // Report where the first one got to instead of restarting.
        const scraping = core.chatState?.loginScrape?.[topicKey]
        if (scraping && now < (scraping.hardDeadline ?? 0)) {
            dbg("LOGIN", `already scraping for a sign-in URL on ${session.id}`)
            return { effects: [sendEffect(replyTo, "Already running /login on this session — still waiting for the sign-in URL to come up.")] }
        }
        const armed = core.chatState?.pendingLogin?.[topicKey]
        if (armed?.url && (now - (armed.armedAt ?? 0)) < PENDING_LOGIN_TTL_MS) {
            dbg("LOGIN", `re-sending the pending sign-in URL for ${session.id}`)
            return { effects: [sendEffect(replyTo, `Already waiting on the code for this one:\n\n${armed.url}`)] }
        }

        dbg("LOGIN", `starting login sequence on session ${session.id}`)
        return {
            stateChanges: { chatState: { loginScrape: { [topicKey]: undefined }, loginConfirm: { [topicKey]: undefined } } },
            effects: [
                { type: "send_raw_input_to_claude", sessionId: session.id, text: "/login" },
                selfMessageTimerEffect(event, "/login __url", URL_RENDER_DELAY_MS, "login_url"),
            ],
        }
    },
}
