// tests/dtach-socket-identity-test.js
//
// A session's dtach socket has to be the one it is really running inside.
// cbg used to take it from state/next_session.json, a single slot the next
// spawn overwrites — so two sessions starting in the same second (a daemon
// restart, or /refresh in several topics) traded sockets, and the loser
// spent the rest of its life having its reply nudges, /peek and /raw typed
// into a stranger's terminal. Registration now reads the socket back off
// the live dtach process instead.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, writeAccess, makeCore, get } from "./_helpers.js"

setupTempPaths("cbg-dtach-socket-test-")

const { parseDtachSocketFromArgs } = await import("../lib/pure/dtach-args.js")
const { findDtachSocketStrict } = await import("../lib/pid.js")
const handler = (await import("../lib/event-handlers/session-register.js")).default

Deno.test("argv parse: the socket follows the mode flag", () => {
    assertEquals(
        parseDtachSocketFromArgs("/nix/store/bin/dtach -n /state/dtach-RoundBeaver.sock -Ez script -q -F /state/x.log bash -c cd ~ && claude"),
        "/state/dtach-RoundBeaver.sock",
    )
    assertEquals(parseDtachSocketFromArgs("dtach -c /tmp/a.sock bash"), "/tmp/a.sock")
    assertEquals(parseDtachSocketFromArgs("dtach -A /tmp/b.sock -r winch bash"), "/tmp/b.sock")
    assertEquals(parseDtachSocketFromArgs("dtach -p /tmp/c.sock"), "/tmp/c.sock")
})

Deno.test("argv parse: anything that isn't a dtach invocation yields null", () => {
    assertEquals(parseDtachSocketFromArgs("script -q -F /state/x.log bash -c 'dtach -n /tmp/a.sock'"), null)
    assertEquals(parseDtachSocketFromArgs("claude --no-tele"), null)
    assertEquals(parseDtachSocketFromArgs("dtach"), null)
    assertEquals(parseDtachSocketFromArgs("dtach -n"), null)
    assertEquals(parseDtachSocketFromArgs("dtach -Ez bash"), null)
    assertEquals(parseDtachSocketFromArgs(""), null)
    assertEquals(parseDtachSocketFromArgs(null), null)
})

Deno.test({
    name: "ancestry walk reports the socket a live process is really inside",
    // dtach isn't guaranteed on a CI box; the parse tests cover the logic.
    ignore: !hasDtach(),
    async fn() {
        const dir = Deno.makeTempDirSync({ prefix: "cbg-dtach-probe-" })
        const sock = `${dir}/probe.sock`
        // `dtach -n` daemonizes, so the sleep we look up by pid still has
        // that dtach in its ancestry — exactly the shape a cbg session has.
        await new Deno.Command("dtach", {
            args: ["-n", sock, "-z", "sleep", "30"],
            stdout: "null",
            stderr: "null",
        }).output()
        const dtachPid = await waitForPid(`dtach -n ${sock}`)
        const childPid = dtachPid == null ? null : pidOfChild(dtachPid)
        try {
            assert(childPid != null, "probe process never appeared")
            assertEquals(findDtachSocketStrict(childPid), sock)
        } finally {
            for (const pid of [childPid, dtachPid]) {
                if (pid != null) { try { Deno.kill(pid, "SIGKILL") } catch (_) { /* already gone */ } }
            }
            try { Deno.removeSync(dir, { recursive: true }) } catch (_) { /* best effort */ }
        }
    },
})

Deno.test("registration keeps the reported socket when there is no dtach ancestor", () => {
    writeAccess(["42"])
    const core = makeCore()
    const action = handler({
        type: "session_register",
        // pid 0 — no ancestry to walk, as when a session runs bare
        session: { id: "BareSession", cwd: "/repo/foo", pid: 0, dtachSocket: "/state/dtach-BareSession.sock" },
    }, core)
    assertEquals(get(action, "stateChanges.chatSessions.BareSession.dtachSocket"), "/state/dtach-BareSession.sock")
})

function hasDtach() {
    try {
        const r = new Deno.Command("sh", { args: ["-c", "command -v dtach"], stdout: "null", stderr: "null" }).outputSync()
        return r.success
    } catch (_) {
        return false
    }
}

async function waitForPid(pattern) {
    for (let i = 0; i < 50; i++) {
        const pid = pgrep(pattern)
        if (pid != null) { return pid }
        await new Promise(r => setTimeout(r, 100))
    }
    return null
}

function pgrep(pattern) {
    const out = new Deno.Command("sh", {
        args: ["-c", `pgrep -f ${JSON.stringify(pattern)} | head -1`],
        stdout: "piped",
        stderr: "null",
    }).outputSync()
    const pid = parseInt(new TextDecoder().decode(out.stdout).trim())
    return pid > 0 ? pid : null
}

function pidOfChild(parentPid) {
    const out = new Deno.Command("sh", {
        args: ["-c", `pgrep -P ${parentPid} | head -1`],
        stdout: "piped",
        stderr: "null",
    }).outputSync()
    const pid = parseInt(new TextDecoder().decode(out.stdout).trim())
    return pid > 0 ? pid : null
}

// ── Identity, not just the socket ─────────────────────────────────────
// The same single slot also hands out the session *id*. A late-booting
// shim used to read whatever the last spawn wrote, so it answered to
// another topic's name. The env is per-process, so it decides.

const { resolveSessionIdentity } = await import("../lib/pure/session-identity.js")

Deno.test("identity: env wins over a slot written by a later spawn", () => {
    const identity = resolveSessionIdentity({
        envId: "ElderlyAmphibian",
        slot: { id: "DistinctiveReindeer", title: "Life", dtachSocket: "/state/dtach-DistinctiveReindeer.sock" },
    })
    assertEquals(identity.id, "ElderlyAmphibian")
    assertEquals(identity.source, "env")
    // someone else's slot: neither borrow from it nor delete it
    assertEquals(identity.title, null)
    assertEquals(identity.dtachSocket, null)
    assertEquals(identity.consumeSlot, false)
})

Deno.test("identity: our own slot still supplies title and socket", () => {
    const identity = resolveSessionIdentity({
        envId: "RoundBeaver",
        slot: { id: "RoundBeaver", title: "jeffhykin (master)", dtachSocket: "/state/dtach-RoundBeaver.sock" },
    })
    assertEquals(identity.id, "RoundBeaver")
    assertEquals(identity.title, "jeffhykin (master)")
    assertEquals(identity.dtachSocket, "/state/dtach-RoundBeaver.sock")
    assertEquals(identity.consumeSlot, true)
})

Deno.test("identity: env title beats the slot's", () => {
    const identity = resolveSessionIdentity({
        envId: "RoundBeaver",
        envTitle: "dimos (main)",
        slot: { id: "RoundBeaver", title: "stale" },
    })
    assertEquals(identity.title, "dimos (main)")
})

Deno.test("identity: no env falls back to the slot, as older spawners rely on", () => {
    const identity = resolveSessionIdentity({
        slot: { id: "SignificantQuail", title: "Life", dtachSocket: "/state/dtach-SignificantQuail.sock" },
    })
    assertEquals(identity.id, "SignificantQuail")
    assertEquals(identity.source, "slot")
    assertEquals(identity.consumeSlot, true)
})

Deno.test("identity: nothing to go on -> caller generates a name", () => {
    assertEquals(resolveSessionIdentity({}).id, null)
    // `cbg claude` writes a slot with a socket but no id
    assertEquals(resolveSessionIdentity({ slot: { dtachSocket: "/state/dtach-01a4a3.sock" } }).id, null)
})

// ── Repairing a mis-map that already happened ─────────────────────────
// A reload doesn't drop shim connections, so a session recorded against
// the wrong socket never re-registers and the bad entry outlives every
// `cbg reinstall`. `cbg reinstall` now re-derives it in place.

const { planSocketRepairs } = await import("../lib/pure/session-identity.js")

Deno.test("repair: only sessions whose real socket differs are listed", () => {
    const sessions = {
        Wrong: { pid: 2303, dtachSocket: "/state/dtach-DistinctiveReindeer.sock" },
        Right: { pid: 46697, dtachSocket: "/state/dtach-RoundBeaver.sock" },
        NoPid: { pid: 0, dtachSocket: "/state/dtach-Ghost.sock" },
        Dead: { pid: 999999, dtachSocket: "/state/dtach-Dead.sock" },
    }
    const real = {
        2303: "/state/dtach-ElderlyAmphibian.sock",
        46697: "/state/dtach-RoundBeaver.sock",
        999999: null,
    }
    const repairs = planSocketRepairs(sessions, pid => real[pid] ?? null)
    assertEquals(repairs, [{
        id: "Wrong",
        from: "/state/dtach-DistinctiveReindeer.sock",
        to: "/state/dtach-ElderlyAmphibian.sock",
    }])
})

Deno.test("repair: a throwing ancestry lookup skips that session, not the sweep", () => {
    const sessions = {
        Boom: { pid: 1, dtachSocket: "/state/a.sock" },
        Fine: { pid: 2, dtachSocket: "/state/b.sock" },
    }
    const repairs = planSocketRepairs(sessions, pid => {
        if (pid === 1) { throw new Error("ps blew up") }
        return "/state/real-b.sock"
    })
    assertEquals(repairs.map(r => r.id), ["Fine"])
})
