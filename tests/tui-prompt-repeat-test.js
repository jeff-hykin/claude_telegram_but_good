import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { versionedImport } from "../lib/version.js"

const { default: snapshot } = await versionedImport("../lib/event-handlers/tui-snapshot.js", import.meta)
const { default: promptDetected } = await versionedImport("../lib/event-handlers/tui-prompt-detected.js", import.meta)

const PROCEED = "\r\n Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. No\r\n\r\n Esc to cancel · Tab to amend"

// One snapshot tick, feeding each detected prompt to its handler; returns the keystrokes sent
function tick(core) {
    const sent = []
    for (const event of snapshot({ type: "screen_snapshot_tick", ts: 1 }, core).followUpEvents) {
        const action = promptDetected(event, core)
        if (action) {
            Object.assign(core.chatSessions.S, action.stateChanges.chatSessions.S)
            sent.push(...action.effects.filter((e) => e.type === "send_text_to_claude").map((e) => e.text))
        }
    }
    return sent
}

Deno.test("every 'Do you want to proceed?' gets answered once, not just the first", () => {
    const dir = Deno.makeTempDirSync()
    const log = `${dir}/dtach-S.log`
    Deno.writeTextFileSync(log, "rm -f $P/*.png" + PROCEED)
    const core = { chatSessions: { S: { status: "working", dtachSocket: `${dir}/dtach-S.sock` } } }

    assertEquals(tick(core), ["1"])
    assertEquals(tick(core), [], "an answered prompt still in the tail is not re-answered")
    Deno.writeTextFileSync(log, "\x1b[H\x1b[58C1:59", { append: true })
    assertEquals(tick(core), [], "a countdown redraw is not a new prompt")
    Deno.writeTextFileSync(log, "rm -f $P/*.png" + PROCEED, { append: true })
    assertEquals(tick(core), ["1"], "the next proceed prompt in the same session is answered")
    Deno.removeSync(dir, { recursive: true })
})

Deno.test("the same words scrolled off screen (pasted text, tool output) are not answered", () => {
    const dir = Deno.makeTempDirSync()
    const log = `${dir}/dtach-S.log`
    const pastedThenMoreOutput = PROCEED + "\r\nI lost an entire overnight run" + "\r\n⏺ working on it".repeat(60)
    Deno.writeTextFileSync(log, pastedThenMoreOutput)
    const core = { chatSessions: { S: { status: "working", dtachSocket: `${dir}/dtach-S.sock` } } }

    assertEquals(tick(core), [])
    Deno.removeSync(dir, { recursive: true })
})
