import { assertEquals, assertStrictEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { mergeSessionData } from "../lib/pure/state-merge.js"

Deno.test("basic object merge adds new keys", () => {
    const out = mergeSessionData({ a: 1 }, { b: 2 })
    assertEquals(out, { a: 1, b: 2 })
})

Deno.test("basic object merge overwrites existing keys", () => {
    const out = mergeSessionData({ a: 1, b: 2 }, { b: 99 })
    assertEquals(out, { a: 1, b: 99 })
})

Deno.test("target undefined produces patch as new object", () => {
    const out = mergeSessionData(undefined, { a: 1 })
    assertEquals(out, { a: 1 })
})

Deno.test("target null is treated as empty object", () => {
    const out = mergeSessionData(null, { a: 1, b: 2 })
    assertEquals(out, { a: 1, b: 2 })
})

Deno.test("target as non-object primitive is treated as empty object", () => {
    const out = mergeSessionData(42, { a: 1 })
    assertEquals(out, { a: 1 })
})

Deno.test("nested object merge (2 levels deep) preserves siblings", () => {
    const out = mergeSessionData(
        { a: { x: 1, y: 2 } },
        { a: { y: 3, z: 4 } },
    )
    assertEquals(out, { a: { x: 1, y: 3, z: 4 } })
})

Deno.test("deep nested merge (3 levels) preserves sibling keys", () => {
    const target = {
        outer: {
            middle: {
                keep: "me",
                change: "old",
            },
            sibling: "untouched",
        },
        toplevel: "stay",
    }
    const patch = {
        outer: {
            middle: {
                change: "new",
                added: "yes",
            },
        },
    }
    const out = mergeSessionData(target, patch)
    assertEquals(out, {
        outer: {
            middle: {
                keep: "me",
                change: "new",
                added: "yes",
            },
            sibling: "untouched",
        },
        toplevel: "stay",
    })
})

Deno.test("undefined value in patch deletes key at top level", () => {
    const out = mergeSessionData({ a: 1, b: 2 }, { b: undefined })
    assertEquals(out, { a: 1 })
    assertEquals("b" in out, false)
})

Deno.test("undefined value in patch deletes nested key", () => {
    const out = mergeSessionData(
        { a: { x: 1, y: 2 } },
        { a: { y: undefined } },
    )
    assertEquals(out, { a: { x: 1 } })
})

Deno.test("undefined on a whole subtree deletes the subtree", () => {
    const out = mergeSessionData({ a: { x: 1 } }, { a: undefined })
    assertEquals(out, {})
    assertEquals("a" in out, false)
})

Deno.test("arrays replace wholesale, do not merge item-by-item", () => {
    const out = mergeSessionData({ a: [1, 2, 3] }, { a: [9] })
    assertEquals(out, { a: [9] })
})

Deno.test("array replaces object and vice versa", () => {
    const out1 = mergeSessionData({ a: { x: 1 } }, { a: [1, 2] })
    assertEquals(out1, { a: [1, 2] })
    const out2 = mergeSessionData({ a: [1, 2] }, { a: { x: 1 } })
    assertEquals(out2, { a: { x: 1 } })
})

Deno.test("scalar replaces object", () => {
    const out = mergeSessionData({ a: { x: 1 } }, { a: 5 })
    assertEquals(out, { a: 5 })
})

Deno.test("patch null returns null", () => {
    const out = mergeSessionData({ a: 1 }, null)
    assertStrictEquals(out, null)
})

Deno.test("patch primitive replaces entirely", () => {
    assertStrictEquals(mergeSessionData({ a: 1 }, 5), 5)
    assertStrictEquals(mergeSessionData({ a: 1 }, "hi"), "hi")
    assertStrictEquals(mergeSessionData({ a: 1 }, true), true)
})

Deno.test("patch undefined returns undefined sentinel", () => {
    assertStrictEquals(mergeSessionData({ a: 1 }, undefined), undefined)
})

Deno.test("does not mutate target", () => {
    const target = { a: { x: 1, y: 2 } }
    const snapshot = JSON.stringify(target)
    const out = mergeSessionData(target, { a: { y: 3 } })
    assertEquals(JSON.stringify(target), snapshot)
    assertEquals(out.a.y, 3)
    assertEquals(out.a.x, 1)
})

Deno.test("returned object is a new reference, not the target", () => {
    const target = { a: 1 }
    const out = mergeSessionData(target, { b: 2 })
    assertEquals(out !== target, true)
})

Deno.test("nested merge returns new nested reference", () => {
    const target = { a: { x: 1 } }
    const out = mergeSessionData(target, { a: { y: 2 } })
    assertEquals(out.a !== target.a, true)
    assertEquals(target.a.y, undefined)
})

Deno.test("empty patch object returns shallow copy of target", () => {
    const target = { a: 1, b: 2 }
    const out = mergeSessionData(target, {})
    assertEquals(out, { a: 1, b: 2 })
    assertEquals(out !== target, true)
})

Deno.test("empty target and empty patch yields empty object", () => {
    const out = mergeSessionData({}, {})
    assertEquals(out, {})
})

Deno.test("deleting a non-existent key is a no-op", () => {
    const out = mergeSessionData({ a: 1 }, { b: undefined })
    assertEquals(out, { a: 1 })
})
