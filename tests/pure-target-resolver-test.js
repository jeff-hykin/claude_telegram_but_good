// tests/pure-target-resolver-test.js
//
// Unit tests for lib/pure/target-resolver.js — the prefix-aware address
// parser and resolver used by tell_session + ask_sync.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { parseTargetAddress, resolveTarget } from "../lib/pure/target-resolver.js"

function connSentinel(label) {
    return { __label: label, write: () => Promise.resolve(), close: () => {}, read: () => Promise.resolve(null) }
}

function makeCore({ sessions = {}, topicMap = {}, topicNames = {} } = {}) {
    return {
        chatSessions: sessions,
        chatState: { commandCenter: { topicMap, topicNames } },
    }
}

Deno.test("parse: bare string is auto mode", () => {
    assertEquals(parseTargetAddress("foo"), { mode: "auto", value: "foo" })
})

Deno.test("parse: session:/topic:/title:/inbox:/cbg: prefixes strip cleanly", () => {
    assertEquals(parseTargetAddress("session:Foo"), { mode: "session", value: "Foo" })
    assertEquals(parseTargetAddress("topic:bar"),   { mode: "topic",   value: "bar" })
    assertEquals(parseTargetAddress("title:dim"),   { mode: "title",   value: "dim" })
    assertEquals(parseTargetAddress("inbox:cli1"),  { mode: "inbox",   value: "cli1" })
    assertEquals(parseTargetAddress("cbg:baz"),     { mode: "auto",    value: "baz" })
})

Deno.test("parse: uppercase prefix works (case-insensitive)", () => {
    assertEquals(parseTargetAddress("Session:Abc"), { mode: "session", value: "Abc" })
})

Deno.test("parse: unknown prefix falls back to auto with ORIGINAL raw", () => {
    // so a session ID like "weird:name" still resolves via auto
    assertEquals(parseTargetAddress("random:x"), { mode: "auto", value: "random:x" })
})

Deno.test("parse: empty string is safe", () => {
    assertEquals(parseTargetAddress(""), { mode: "auto", value: "" })
    assertEquals(parseTargetAddress(null), { mode: "auto", value: "" })
})

Deno.test("resolve session: exact match returns session, miss returns error", () => {
    const sA = { id: "A", _conn: connSentinel("a") }
    const core = makeCore({ sessions: { A: sA } })
    const hit = resolveTarget("session:A", core)
    assert(hit.session === sA)
    const miss = resolveTarget("session:Z", core)
    assert(miss.error.includes("Z"))
})

Deno.test("resolve topic: requires topicMap + topicNames wiring", () => {
    const sA = { id: "A", _conn: connSentinel("a") }
    const core = makeCore({
        sessions: { A: sA },
        topicMap: { A: 42 },
        topicNames: { 42: "mytopic" },
    })
    const hit = resolveTarget("topic:mytopic", core)
    assert(hit.session === sA)
    // topic mismatch errors (no silent fallback to session/title)
    const miss = resolveTarget("topic:ghost", core)
    assert(miss.error.includes("ghost"))
})

Deno.test("resolve topic: ambiguous error lists candidates", () => {
    const sA = { id: "A", _conn: connSentinel("a") }
    const sB = { id: "B", _conn: connSentinel("b") }
    const core = makeCore({
        sessions: { A: sA, B: sB },
        topicMap: { A: 1, B: 1 },
        topicNames: { 1: "shared" },
    })
    const out = resolveTarget("topic:shared", core)
    assert(out.error.includes("ambiguous"))
    assert(out.error.includes("A"))
    assert(out.error.includes("B"))
    assert(out.ambiguous === true)
})

Deno.test("resolve title: substring match returns session", () => {
    const sA = { id: "A", title: "dimos2", _conn: connSentinel("a") }
    const core = makeCore({ sessions: { A: sA } })
    const hit = resolveTarget("title:dim", core)
    assert(hit.session === sA)
})

Deno.test("resolve inbox: returns { inbox } regardless of sessions", () => {
    const core = makeCore()
    const out = resolveTarget("inbox:my_cli", core)
    assertEquals(out.inbox, "my_cli")
    assertEquals(out.session, undefined)
})

Deno.test("resolve inbox: empty value errors", () => {
    const core = makeCore()
    const out = resolveTarget("inbox:", core)
    assert(out.error.includes("empty"))
})

Deno.test("resolve auto: session ID → topic → title cascade", () => {
    const sA = { id: "A", _conn: connSentinel("a") }
    const sB = { id: "B", title: "matches-by-title", _conn: connSentinel("b") }
    const core = makeCore({
        sessions: { A: sA, B: sB },
        topicMap: { A: 5 },
        topicNames: { 5: "topic_of_a" },
    })
    assert(resolveTarget("A", core).session === sA)                   // session hit
    assert(resolveTarget("topic_of_a", core).session === sA)          // topic hit
    assert(resolveTarget("matches-by-title", core).session === sB)    // title hit
    assert(resolveTarget("cbg:A", core).session === sA)               // cbg: is auto
})

Deno.test("resolve auto: no match anywhere errors with combined message", () => {
    const core = makeCore({ sessions: {} })
    const out = resolveTarget("nothing", core)
    assert(out.error.includes("session ID"))
    assert(out.error.includes("topic"))
    assert(out.error.includes("title"))
})

Deno.test("resolve auto: ambiguous topic short-circuits before title fallback", () => {
    const sA = { id: "A", title: "sharedname", _conn: connSentinel("a") }
    const sB = { id: "B", _conn: connSentinel("b") }
    const core = makeCore({
        sessions: { A: sA, B: sB },
        topicMap: { A: 1, B: 1 },
        topicNames: { 1: "sharedname" },
    })
    const out = resolveTarget("sharedname", core)
    assert(out.ambiguous === true, "should surface the ambiguous topic error, not silently match the title")
})
