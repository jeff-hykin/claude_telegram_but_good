// tests/shim-hot-reload-test.js
//
// Verifies the server → shim `version_bumped` broadcast that drives
// Phase 6 shim in-session hot reload.
//
// `broadcastVersionToShims` is tested in isolation so we don't need
// real sockets or a running shim — the test provides fake conns whose
// `write()` captures the framed bytes. `bumpCbgVersion` is covered
// through a snapshot/restore of `lib/version.js` so the test can't
// corrupt the checked-in constant.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, makeCore } from "./_helpers.js"

setupTempPaths("cbg-hotreload-test-")

const { bumpCbgVersion, broadcastVersionToShims } = await import("../lib/effects/filesystem.js")
const { sibling } = await import("../imports.js")

function recordingConn(label = "conn") {
    const writes = []
    return {
        __label: label,
        writes,
        write(bytes) {
            writes.push(new TextDecoder().decode(bytes))
            return Promise.resolve(bytes.length)
        },
        read: () => Promise.resolve(null),
        close: () => {},
    }
}

function parseFrames(writes) {
    // Each write is one newline-delimited JSON frame.
    return writes
        .join("")
        .split("\n")
        .filter(line => line.length > 0)
        .map(line => JSON.parse(line))
}

Deno.test("broadcastVersionToShims: sends version_bumped to every session with a _conn", () => {
    const c1 = recordingConn("s1")
    const c2 = recordingConn("s2")
    const core = makeCore({
        chatSessions: {
            "s1": { id: "s1", _conn: c1 },
            "s2": { id: "s2", _conn: c2 },
        },
    })
    broadcastVersionToShims(core, 42)

    for (const c of [c1, c2]) {
        const frames = parseFrames(c.writes)
        assertEquals(frames.length, 1)
        assertEquals(frames[0].type, "version_bumped")
        assertEquals(frames[0].version, 42)
    }
})

Deno.test("broadcastVersionToShims: skips sessions missing _conn", () => {
    const c1 = recordingConn("s1")
    const core = makeCore({
        chatSessions: {
            "s1": { id: "s1", _conn: c1 },
            "s2": { id: "s2" },  // no conn — shim is disconnected
        },
    })
    // Must not throw even though s2 has nothing to write to.
    broadcastVersionToShims(core, 7)
    assertEquals(parseFrames(c1.writes).length, 1)
})

Deno.test("broadcastVersionToShims: a single failing write does not block the other shims", () => {
    const dead = {
        __label: "dead",
        write() { throw new Error("broken pipe") },
        close: () => {},
    }
    const alive = recordingConn("alive")
    const core = makeCore({
        chatSessions: {
            "d": { id: "d", _conn: dead },
            "a": { id: "a", _conn: alive },
        },
    })
    broadcastVersionToShims(core, 3)
    assertEquals(parseFrames(alive.writes).length, 1)
})

Deno.test("broadcastVersionToShims: empty chatSessions is a no-op (no throw)", () => {
    const core = makeCore({ chatSessions: {} })
    broadcastVersionToShims(core, 5)
    // Nothing to assert — the invariant is that the call doesn't throw.
    assert(true)
})

Deno.test("broadcastVersionToShims: tolerates core.chatSessions being undefined", () => {
    const core = makeCore()
    // Forcing the backing slot to undefined via the setter.
    core.chatSessions = undefined
    broadcastVersionToShims(core, 5)
    assert(true)
})

// ── bumpCbgVersion: integration test with version.js snapshot/restore ──

Deno.test("bumpCbgVersion: updates globalThis.cbgVersion and broadcasts to shims", async () => {
    // Snapshot version.js so we can restore it after the test — the
    // effect rewrites it in place and we don't want that bleeding into
    // the checked-in source.
    const versionJsPath = sibling(import.meta, "../lib/version.js")
    const original = Deno.readTextFileSync(versionJsPath)
    try {
        const prev = globalThis.cbgVersion ?? 1
        const c1 = recordingConn("s1")
        const core = makeCore({
            chatSessions: { "s1": { id: "s1", _conn: c1 } },
        })
        bumpCbgVersion({ type: "bump_cbg_version" }, core)

        assertEquals(globalThis.cbgVersion, prev + 1)
        const frames = parseFrames(c1.writes)
        assertEquals(frames.length, 1)
        assertEquals(frames[0].type, "version_bumped")
        assertEquals(frames[0].version, prev + 1)

        // Disk was rewritten
        const updated = Deno.readTextFileSync(versionJsPath)
        assert(updated.includes(`export const VERSION = ${prev + 1}`))
    } finally {
        Deno.writeTextFileSync(versionJsPath, original)
        // Restore globalThis.cbgVersion from the preserved constant so
        // any later tests in the same process see the original number.
        const match = /export const VERSION = (\d+)/.exec(original)
        if (match) {
            globalThis.cbgVersion = Number(match[1])
        }
    }
})

Deno.test("bumpCbgVersion: explicit toVersion wins over auto-increment", async () => {
    const versionJsPath = sibling(import.meta, "../lib/version.js")
    const original = Deno.readTextFileSync(versionJsPath)
    try {
        const c1 = recordingConn("s1")
        const core = makeCore({
            chatSessions: { "s1": { id: "s1", _conn: c1 } },
        })
        bumpCbgVersion({ type: "bump_cbg_version", toVersion: 999 }, core)
        assertEquals(globalThis.cbgVersion, 999)
        const frames = parseFrames(c1.writes)
        assertEquals(frames[0].version, 999)
    } finally {
        Deno.writeTextFileSync(versionJsPath, original)
        const match = /export const VERSION = (\d+)/.exec(original)
        if (match) {
            globalThis.cbgVersion = Number(match[1])
        }
    }
})

// ── Shim-side version_bumped semantics (pure logic, inlined for test) ──
//
// mcp-shim.js's handler for `version_bumped` is four lines; rather than
// try to import that module (it has side effects like opening stdio
// transports), we re-express its pure rule here so we can test the
// decision logic. If the shim's handler is refactored, keep this block
// in sync — it's documented as a reference copy.

function applyVersionBumped(msg) {
    if (typeof msg.version === "number" && msg.version > (globalThis.cbgVersion ?? 0)) {
        globalThis.cbgVersion = msg.version
        return true
    }
    return false
}

Deno.test("shim rule: version_bumped accepts a higher version", () => {
    const start = globalThis.cbgVersion ?? 1
    try {
        const applied = applyVersionBumped({ type: "version_bumped", version: start + 10 })
        assertEquals(applied, true)
        assertEquals(globalThis.cbgVersion, start + 10)
    } finally {
        globalThis.cbgVersion = start
    }
})

Deno.test("shim rule: version_bumped rejects a lower version (downgrade guard)", () => {
    const start = globalThis.cbgVersion ?? 1
    globalThis.cbgVersion = start + 50
    try {
        const applied = applyVersionBumped({ type: "version_bumped", version: start })
        assertEquals(applied, false)
        assertEquals(globalThis.cbgVersion, start + 50)
    } finally {
        globalThis.cbgVersion = start
    }
})

Deno.test("shim rule: version_bumped ignores non-numeric versions", () => {
    const start = globalThis.cbgVersion ?? 1
    assertEquals(applyVersionBumped({ type: "version_bumped", version: "7" }), false)
    assertEquals(applyVersionBumped({ type: "version_bumped" }), false)
    assertEquals(globalThis.cbgVersion, start)
})
