import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { replyToForSession } from "../lib/pure/reply-to.js"

Deno.test("session reply retains inbound topic after its mapping is removed", () => {
    const core = { chatSessions: { Old: { lastInbound: { chatId: "-100", threadId: 55 } } } }
    assertEquals(replyToForSession("Old", core, "test"), { chatId: "-100", threadId: 55, setBy: "test" })
})

Deno.test("current topic mapping takes precedence over inbound topic", () => {
    const core = {
        chatState: { commandCenter: { chatId: "-200", topicMap: { Old: 66 } } },
        chatSessions: { Old: { lastInbound: { chatId: "-100", threadId: 55 } } },
    }
    assertEquals(replyToForSession("Old", core, "test"), { chatId: "-200", threadId: 66, setBy: "test" })
})
