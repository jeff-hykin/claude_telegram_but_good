import { scanForDisconnect, DISCONNECT_RE } from "../lib/pure/disconnect-scan.js"
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"

Deno.test("matches the retry banner with middot", () => {
    const raw = "some output\n⎿  Retrying in 0s · attempt 7/10\nmore"
    assertEquals(scanForDisconnect(raw), { attempt: 7, max: 10 })
})

Deno.test("matches with dash separator and spacing", () => {
    const raw = "Retrying in 12s - attempt 3 / 10"
    assertEquals(scanForDisconnect(raw), { attempt: 3, max: 10 })
})

Deno.test("no banner -> null", () => {
    assertEquals(scanForDisconnect("just normal output\nworking on it"), null)
})

Deno.test("empty -> null", () => {
    assertEquals(scanForDisconnect(""), null)
    assertEquals(scanForDisconnect(null), null)
})
