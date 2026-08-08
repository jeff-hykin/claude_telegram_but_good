// tests/raw-and-login-test.js
//
// Covers the terminal-injection commands (/raw + the arrow keys) and the
// /login round-trip: run the keystrokes, scrape the OAuth URL off the
// session's screen, and type the code the user pastes back.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, paths, makeCore, effectsOfType, writeAccess } from "./_helpers.js"

setupTempPaths("cbg-raw-login-test-")
writeAccess(["42"])

const { extractLoginUrl, looksLikeLoginCode, loginTopicKey, awaitsLoginMethod, isOpeningBrowser, awaitsLoginConfirm } = await import("../lib/pure/login.js")
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

// --- injecting into the session the topic is actually showing --------------

const CC_THREAD = "19"
const DETACHED = "GhostOtter"

function inCommandCenter(run) {
    Deno.writeTextFileSync(
        paths.ACCESS_FILE,
        JSON.stringify({ dmPolicy: "pairing", allowFrom: [CHAT], groups: {}, pending: {}, commandCenterChatId: CHAT }),
    )
    try {
        return run()
    } finally {
        writeAccess([CHAT])
    }
}

const topicEvent = (text) => ({ ...userEvent(text), chatType: "supergroup", threadId: CC_THREAD })

const topicCore = () => makeCore({
    chatState: {
        commandCenter: { threadMap: { [CC_THREAD]: DETACHED } },
        focusedSessionId: SESSION,
    },
    chatSessions: { [SESSION]: { id: SESSION, dtachSocket: SOCKET() } },
})

Deno.test("/raw types into the topic's own session even when its shim hasn't registered", () => {
    Deno.writeTextFileSync(`${paths.STATE_DIR}/dtach-${DETACHED}.sock`, "")
    inCommandCenter(() => {
        const action = registry.get("raw")(topicEvent("/raw hello"), topicCore())
        assertEquals(rawInputs(action).length, 1)
        assertEquals(rawInputs(action)[0].sessionId, DETACHED)
    })
})

Deno.test("/raw says so instead of typing into a different session when the terminal is gone", () => {
    Deno.removeSync(`${paths.STATE_DIR}/dtach-${DETACHED}.sock`)
    inCommandCenter(() => {
        const action = registry.get("raw")(topicEvent("/raw hello"), topicCore())
        assertEquals(rawInputs(action).length, 0)
        assertEquals(effectsOfType(action, "send_text_to_user").length, 1)
    })
})

// --- /login ----------------------------------------------------------------

const TOPIC_KEY = loginTopicKey(CHAT, null)
const CODE = "PxT9dK2mQ7vLbN4wZaEr#s0meStateValue"
const expired = () => Date.now() - 1000
const scrapeUrl = () => registry.get("login")(userEvent("/login __url"), coreWithSession())
const writeScreen = (screen) => Deno.writeTextFileSync(SOCKET().replace(/\.sock$/, ".log"), screen)

Deno.test("/login types the slash command and nothing else — a stray Enter cancels the panel", () => {
    const action = registry.get("login")(userEvent("/login"), coreWithSession())
    assertEquals(rawInputs(action).length, 1)
    assertEquals(rawInputs(action)[0].text, "/login")
    const followUps = effectsOfType(action, "set_timer").map((e) => e.event.text)
    assertEquals(followUps, ["/login __url"])
})

Deno.test("/login __url waits for a second scrape to agree before trusting the URL", () => {
    writeScreen(BOXED_SCREEN)
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
    writeScreen("just a shell prompt $")
    const action = scrapeUrl()
    assertEquals(effectsOfType(action, "send_text_to_user").length, 0)
    assertEquals(effectsOfType(action, "set_timer")[0].event.text, "/login __url")
    assertEquals(action.stateChanges.chatState.pendingLogin, undefined)
})

// What /login opens with. Nothing else happens until it's answered.
const METHOD_PICKER_SCREEN = [
    "   Login",
    "",
    "   Select login method:",
    "",
    "   ❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise",
    "     2. Anthropic Console account · API usage billing",
    "",
    "   Esc to cancel",
].join("\n")

Deno.test("/login __url answers the account-type picker with Return", () => {
    writeScreen(METHOD_PICKER_SCREEN)
    const action = scrapeUrl()
    const [enter] = rawInputs(action)
    assertEquals(enter.text, "")
    assertEquals(enter.submit, undefined)
    assertEquals(action.stateChanges.chatState.loginScrape[TOPIC_KEY].methodPresses, 1)
    assertEquals(effectsOfType(action, "set_timer")[0].event.text, "/login __url")
})

Deno.test("/login __url doesn't re-press the picker on every scrape", () => {
    writeScreen(METHOD_PICKER_SCREEN)
    const action = registry.get("login")(
        userEvent("/login __url"),
        coreWithSession({
            loginScrape: { [TOPIC_KEY]: { url: null, scrapes: 1, deadline: Date.now() + 30_000, hardDeadline: Date.now() + 60_000, methodPresses: 1, methodPressedAt: Date.now() } },
        }),
    )
    assertEquals(rawInputs(action).length, 0)
    assertEquals(effectsOfType(action, "set_timer")[0].event.text, "/login __url")
})

Deno.test("/login __url stops pressing rather than typing Enter forever", () => {
    writeScreen(METHOD_PICKER_SCREEN)
    const action = registry.get("login")(
        userEvent("/login __url"),
        coreWithSession({
            loginScrape: { [TOPIC_KEY]: { url: null, scrapes: 9, deadline: Date.now() + 30_000, hardDeadline: Date.now() + 60_000, methodPresses: 3, methodPressedAt: 1 } },
        }),
    )
    assertEquals(rawInputs(action).length, 0)
})

Deno.test("/login resumes at an already-open picker instead of typing into it", () => {
    writeScreen(METHOD_PICKER_SCREEN)
    const action = registry.get("login")(userEvent("/login"), coreWithSession())
    assertEquals(rawInputs(action).length, 0)
    const [timer] = effectsOfType(action, "set_timer")
    assertEquals(timer.event.text, "/login __url")
    assertEquals(timer.delayMs, 0)
})

Deno.test("/login __url keeps waiting while the TUI is still opening a browser", () => {
    writeScreen("✢ Opening browser to sign in…")
    const action = registry.get("login")(
        userEvent("/login __url"),
        // Would have expired on its own, but the spinner says otherwise.
        coreWithSession({ loginScrape: { [TOPIC_KEY]: { url: null, scrapes: 40, deadline: expired(), hardDeadline: Date.now() + 60_000 } } }),
    )
    assertEquals(effectsOfType(action, "send_text_to_user").length, 0)
    assertEquals(effectsOfType(action, "set_timer")[0].event.text, "/login __url")
})

Deno.test("/login __url reports failure instead of arming once the budget runs out", () => {
    writeScreen("just a shell prompt $")
    const action = registry.get("login")(
        userEvent("/login __url"),
        coreWithSession({ loginScrape: { [TOPIC_KEY]: { url: null, scrapes: 40, deadline: expired(), hardDeadline: expired() } } }),
    )
    assert(effectsOfType(action, "send_text_to_user")[0].text.includes("couldn't find"))
    assertEquals(action.stateChanges.chatState.pendingLogin, undefined)
})

Deno.test("a repeat /login mid-round-trip resumes instead of typing into the paste prompt", () => {
    const scraping = registry.get("login")(
        userEvent("/login"),
        coreWithSession({ loginScrape: { [TOPIC_KEY]: { url: null, scrapes: 1, deadline: Date.now() + 30_000, hardDeadline: Date.now() + 60_000 } } }),
    )
    assertEquals(rawInputs(scraping).length, 0)
    assert(effectsOfType(scraping, "send_text_to_user")[0].text.includes("Already running"))

    const armed = registry.get("login")(
        userEvent("/login"),
        coreWithSession({ pendingLogin: { [TOPIC_KEY]: { sessionId: SESSION, armedAt: Date.now(), url: "https://claude.ai/oauth/authorize?x=1" } } }),
    )
    assertEquals(rawInputs(armed).length, 0)
    assert(effectsOfType(armed, "send_text_to_user")[0].text.includes("https://claude.ai/oauth/authorize?x=1"))
})

Deno.test("/login starts over once an abandoned round-trip has aged out", () => {
    writeScreen("just a shell prompt $")
    const action = registry.get("login")(
        userEvent("/login"),
        coreWithSession({
            loginScrape: { [TOPIC_KEY]: { url: null, scrapes: 40, deadline: expired(), hardDeadline: expired() } },
            pendingLogin: { [TOPIC_KEY]: { sessionId: SESSION, armedAt: 1, url: "https://claude.ai/oauth/authorize?x=1" } },
        }),
    )
    assertEquals(rawInputs(action)[0].text, "/login")
})

Deno.test("/login <code> types the code, then chases the confirmation panel", () => {
    const action = registry.get("login")(userEvent(`/login ${CODE}`), coreWithSession())
    assertEquals(rawInputs(action).length, 1)
    assertEquals(rawInputs(action)[0].text, CODE)
    assertEquals(action.stateChanges.chatState.pendingLogin[TOPIC_KEY], undefined)
    assertEquals(effectsOfType(action, "set_timer")[0].event.text, "/login __confirm")
})

// --- dismissing "Press Enter to continue…" ---------------------------------

Deno.test("screen predicates match the panels /login actually paints", () => {
    assert(isOpeningBrowser("✢ Opening browser to sign in…"))
    assert(!isOpeningBrowser(BOXED_SCREEN))
    assert(awaitsLoginConfirm("Logged in as jeff@example.com\nLogin successful. Press Enter to continue…"))
    assert(!awaitsLoginConfirm(BOXED_SCREEN))
    assert(awaitsLoginMethod(METHOD_PICKER_SCREEN))
    assert(!awaitsLoginMethod(BOXED_SCREEN))
})

Deno.test("/login __confirm presses Return once the confirmation panel is up", () => {
    writeScreen("Login successful. Press Enter to continue…")
    const action = registry.get("login")(userEvent("/login __confirm"), coreWithSession())
    const [enter] = rawInputs(action)
    assertEquals(enter.text, "")
    assertEquals(enter.submit, undefined)
    assertEquals(action.stateChanges.chatState.loginConfirm[TOPIC_KEY], undefined)
})

Deno.test("/login __confirm waits rather than pressing Return at some other prompt", () => {
    writeScreen("Do you want to proceed? ❯ 1. Yes  2. No")
    const action = registry.get("login")(userEvent("/login __confirm"), coreWithSession())
    assertEquals(rawInputs(action).length, 0)
    assertEquals(effectsOfType(action, "set_timer")[0].event.text, "/login __confirm")
})

Deno.test("/login __confirm gives up quietly instead of pressing Return blind", () => {
    writeScreen("Do you want to proceed? ❯ 1. Yes  2. No")
    const action = registry.get("login")(
        userEvent("/login __confirm"),
        coreWithSession({ loginConfirm: { [TOPIC_KEY]: { deadline: expired() } } }),
    )
    assertEquals(rawInputs(action).length, 0)
    assertEquals(effectsOfType(action, "set_timer")[0].event.text, "/peek")
})

// --- code capture in chat-user --------------------------------------------

const ARMED = { pendingLogin: { [TOPIC_KEY]: { sessionId: SESSION, armedAt: 1 } } }

Deno.test("a pasted code is typed in, then handed to the confirmation step", async () => {
    const action = await handle(userEvent(CODE), coreWithSession(ARMED))
    assertEquals(rawInputs(action).length, 1)
    assertEquals(rawInputs(action)[0].text, CODE)
    const timers = effectsOfType(action, "set_timer")
    assertEquals(timers.length, 1)
    assertEquals(timers[0].event.text, "/login __confirm")
    assertEquals(timers[0].delayMs, 2000)
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
