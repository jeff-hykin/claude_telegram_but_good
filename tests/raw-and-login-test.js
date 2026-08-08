// tests/raw-and-login-test.js
//
// Covers the terminal-injection commands (/raw + the arrow keys) and the
// /login round-trip: run the keystrokes, scrape the OAuth URL off the
// session's screen, and type the code the user pastes back.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, paths, makeCore, effectsOfType, writeAccess } from "./_helpers.js"

setupTempPaths("cbg-raw-login-test-")
writeAccess(["42"])

const { extractLoginUrl, looksLikeLoginCode, loginTopicKey } = await import("../lib/pure/login.js")
const handle = (await import("../lib/event-handlers/chat-user.js")).default

const hotCommandsMod = await import("../lib/hot-commands.js")
await hotCommandsMod.loadCommands(new URL("../commands", import.meta.url).pathname)
const registry = hotCommandsMod.getHotCommands()

const CHAT = "42"
const SESSION = "TestOtter"
const SOCKET = () => `${paths.STATE_DIR}/dtach-${SESSION}.sock`

function coreWithSession(chatState = {}) {
    return makeCore({
        chatState,
        chatSessions: { [SESSION]: { id: SESSION, dtachSocket: SOCKET() } },
    })
}

function userEvent(text) {
    return {
        type: "chat_user_message",
        ts: 1_000_000,
        chatId: CHAT,
        userId: "42",
        username: "jeff",
        messageId: 7,
        chatType: "private",
        attachment: null,
        text,
    }
}

const rawInputs = (action) => effectsOfType(action, "send_raw_input_to_claude")

// --- extractLoginUrl -------------------------------------------------------

const BOXED_SCREEN = [
    "╭──────────────────────────────────────────────────────╮",
    "│ Browser didn't open? Use the url below to sign in:    │",
    "│                                                      │",
    "│ https://claude.ai/oauth/authorize?code=true&client_id │",
    "│ =9d1c&response_type=code&state=abcdefghijklmnop       │",
    "╰──────────────────────────────────────────────────────╯",
    "",
    "Paste code here if prompted >",
].join("\n")

Deno.test("extractLoginUrl: rejoins a URL wrapped across box rows", () => {
    assertEquals(
        extractLoginUrl(BOXED_SCREEN),
        "https://claude.ai/oauth/authorize?code=true&client_id=9d1c&response_type=code&state=abcdefghijklmnop",
    )
})

Deno.test("extractLoginUrl: returns null when the screen has no URL", () => {
    assertEquals(extractLoginUrl("╭────╮\n│ hi │\n╰────╯"), null)
})

Deno.test("extractLoginUrl: does not glue on a short following word", () => {
    const screen = "│ https://example.com/auth?x=1 │\n│ Waiting │"
    assertEquals(extractLoginUrl(screen), "https://example.com/auth?x=1")
})

Deno.test("extractLoginUrl: ignores the panel from an earlier login", () => {
    const screen = `https://claude.ai/oauth/authorize?code=true&stale=1\n\n${BOXED_SCREEN}`
    assert(extractLoginUrl(screen).includes("state=abcdefghijklmnop"))
})

// --- looksLikeLoginCode ----------------------------------------------------

Deno.test("looksLikeLoginCode: accepts code#state and long bare codes", () => {
    assert(looksLikeLoginCode("PxT9dK2mQ7vLbN4wZaEr#s0meStateValue"))
    assert(looksLikeLoginCode("PxT9dK2mQ7vLbN4wZaEr8yUiOp"))
})

Deno.test("looksLikeLoginCode: rejects ordinary messages", () => {
    assert(!looksLikeLoginCode("ok thanks"))
    assert(!looksLikeLoginCode("abc123"))
    assert(!looksLikeLoginCode("this is a much longer sentence than the code"))
})

// --- /raw and the arrow keys ----------------------------------------------

Deno.test("/raw injects the text after the command name, then Enter", () => {
    const action = registry.get("raw")(userEvent("/raw hello world"), coreWithSession())
    assertEquals(rawInputs(action).length, 1)
    assertEquals(rawInputs(action)[0].text, "hello world")
    assertEquals(rawInputs(action)[0].submit, undefined)
})

Deno.test("/raw with no argument sends a bare Enter", () => {
    const action = registry.get("raw")(userEvent("/raw"), coreWithSession())
    assertEquals(rawInputs(action)[0].text, "")
})

Deno.test("arrow keys send one atomic escape sequence and no Enter", () => {
    const expected = { raw_up: "\x1b[A", raw_down: "\x1b[B", raw_right: "\x1b[C", raw_left: "\x1b[D" }
    for (const [cmd, sequence] of Object.entries(expected)) {
        const action = registry.get(cmd)(userEvent(`/${cmd}`), coreWithSession())
        const [effect] = rawInputs(action)
        assertEquals(effect.text, sequence)
        assertEquals(effect.submit, false)
        assertEquals(effect.atomic, true)
    }
})

Deno.test("every injection command peeks afterwards so the result is visible", () => {
    for (const cmd of ["raw", "raw_up", "raw_down", "raw_left", "raw_right"]) {
        const action = registry.get(cmd)(userEvent(`/${cmd}`), coreWithSession())
        const peeks = effectsOfType(action, "set_timer").filter((e) => e.event?.text === "/peek")
        assertEquals(peeks.length, 1, `${cmd} should schedule exactly one peek`)
    }
})

// --- /login ----------------------------------------------------------------

const TOPIC_KEY = loginTopicKey(CHAT, null)
const CODE = "PxT9dK2mQ7vLbN4wZaEr#s0meStateValue"
const scrapeState = (url, scrapes) => ({ loginScrape: { [TOPIC_KEY]: { url, scrapes } } })
const scrapeUrl = () => registry.get("login")(userEvent("/login __url"), coreWithSession())

Deno.test("/login types the slash command and nothing else — a stray Enter cancels the panel", () => {
    const action = registry.get("login")(userEvent("/login"), coreWithSession())
    assertEquals(rawInputs(action).length, 1)
    assertEquals(rawInputs(action)[0].text, "/login")
    const followUps = effectsOfType(action, "set_timer").map((e) => e.event.text)
    assertEquals(followUps, ["/login __url"])
})

Deno.test("/login __url waits for a second scrape to agree before trusting the URL", () => {
    Deno.writeTextFileSync(SOCKET().replace(/\.sock$/, ".log"), BOXED_SCREEN)
    const first = scrapeUrl()
    assertEquals(effectsOfType(first, "send_text_to_user").length, 0)
    assertEquals(effectsOfType(first, "set_timer")[0].event.text, "/login __url")

    const action = registry.get("login")(
        userEvent("/login __url"),
        coreWithSession(first.stateChanges.chatState),
    )
    const sent = effectsOfType(action, "send_text_to_user")
    assertEquals(sent.length, 1)
    assert(sent[0].text.includes("https://claude.ai/oauth/authorize"))
    assertEquals(action.stateChanges.chatState.pendingLogin[TOPIC_KEY].sessionId, SESSION)
    assertEquals(action.stateChanges.chatState.loginScrape[TOPIC_KEY], undefined)
})

Deno.test("/login __url keeps retrying rather than giving up on a blank screen", () => {
    Deno.writeTextFileSync(SOCKET().replace(/\.sock$/, ".log"), "just a shell prompt $")
    const action = scrapeUrl()
    assertEquals(effectsOfType(action, "send_text_to_user").length, 0)
    assertEquals(effectsOfType(action, "set_timer")[0].event.text, "/login __url")
    assertEquals(action.stateChanges.chatState.pendingLogin, undefined)
})

Deno.test("/login __url reports failure instead of arming once the retries run out", () => {
    Deno.writeTextFileSync(SOCKET().replace(/\.sock$/, ".log"), "just a shell prompt $")
    const action = registry.get("login")(
        userEvent("/login __url"),
        coreWithSession(scrapeState(null, 7)),
    )
    assert(effectsOfType(action, "send_text_to_user")[0].text.includes("couldn't find"))
    assertEquals(action.stateChanges.chatState.pendingLogin, undefined)
})

Deno.test("/login <code> types the code instead of restarting the login", () => {
    const action = registry.get("login")(userEvent(`/login ${CODE}`), coreWithSession())
    assertEquals(rawInputs(action).length, 1)
    assertEquals(rawInputs(action)[0].text, CODE)
    assertEquals(action.stateChanges.chatState.pendingLogin[TOPIC_KEY], undefined)
})

// --- code capture in chat-user --------------------------------------------

const ARMED = { pendingLogin: { [TOPIC_KEY]: { sessionId: SESSION, armedAt: 1 } } }

Deno.test("a pasted code is typed into the session, then peeked 5s later", async () => {
    const action = await handle(userEvent(CODE), coreWithSession(ARMED))
    assertEquals(rawInputs(action).length, 1)
    assertEquals(rawInputs(action)[0].text, CODE)
    const timers = effectsOfType(action, "set_timer")
    assertEquals(timers.length, 1)
    assertEquals(timers[0].event.text, "/peek")
    assertEquals(timers[0].delayMs, 5000)
})

Deno.test("the code capture disarms so a later message is never swallowed", async () => {
    const action = await handle(userEvent(CODE), coreWithSession(ARMED))
    assertEquals(action.stateChanges.chatState.pendingLogin[loginTopicKey(CHAT, null)], undefined)
})

Deno.test("a non-code message disarms and is delivered normally", async () => {
    const core = coreWithSession({ ...ARMED, focusedSessionId: SESSION })
    core.chatSessions[SESSION]._conn = { write: () => {} }
    const action = await handle(userEvent("actually never mind"), core)
    assertEquals(rawInputs(action).length, 0)
    assertEquals(action.stateChanges.chatState.pendingLogin[loginTopicKey(CHAT, null)], undefined)
    assertEquals(effectsOfType(action, "deliver_channel_event").length, 1)
})

Deno.test("a dead session tells the user to retry instead of dropping the code", async () => {
    const core = makeCore({ chatState: ARMED, chatSessions: {} })
    const action = await handle(userEvent(CODE), core)
    assertEquals(rawInputs(action).length, 0)
    assert(effectsOfType(action, "send_text_to_user")[0].text.includes("run /login again"))
})
