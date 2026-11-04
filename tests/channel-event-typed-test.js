import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths } from "./_helpers.js"

setupTempPaths("cbg-channel-event-typed-test-")
const { typedChannelTag } = await import("../lib/effects/channel-event.js")

Deno.test("a channel message is typed as the same <channel> tag, minus control characters", () => {
    const text = typedChannelTag("/peek\nrm \x1b[2J \"now\"", { chat_id: "-100", user: "jeff \"h\"" })
    assertEquals(text, `<channel source="plugin:telegram:telegram" chat_id="-100" user="jeff 'h'">\n/peek\nrm [2J "now"\n</channel>`)
})

Deno.test("only a delivery that lands mid-turn is typed in", async () => {
    const { markMidTurnDeliveries } = await import("../lib/main-event-processor.js")
    const effects = [
        { type: "deliver_channel_event", sessionId: "Idle", content: "handoff" },
        { type: "deliver_channel_event", sessionId: "Idle", content: "jeff, right after the handoff" },
        { type: "deliver_channel_event", sessionId: "Busy", content: "jeff, mid-turn" },
        { type: "deliver_channel_event", sessionId: "Fresh", content: "jeff, to an idle session" },
    ]
    markMidTurnDeliveries(effects, { chatSessions: { Idle: { status: "idle" }, Busy: { status: "working" }, Fresh: { status: "idle" } } })
    assertEquals(effects.map((e) => e.midTurn), [false, true, true, false])
})
