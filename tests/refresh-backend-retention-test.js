import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths, makeCore, effectsOfType, paths, loadCommands, getHotCommands } from "./_helpers.js"
setupTempPaths("cbg-refresh-retention-")
Deno.writeTextFileSync(paths.ACCESS_FILE, JSON.stringify({ allowFrom: ["42"], commandCenterChatId: "-100777", groups: {} }))
await loadCommands(new URL("../commands", import.meta.url).pathname)
const event = { chatId: "-100777", threadId: 55, userId: "42", chatType: "supergroup", text: "/refresh" }
Deno.test("refresh retains Codex when its predecessor has been removed", async () => {
    const core = makeCore({ chatState: { commandCenter: { threadMap: { "55": "Gone" }, topicNames: { "55": "test" }, topicBackends: { "55": "codex" } } }, chatSessions: {} })
    const action = await getHotCommands().get("refresh")(event, core)
    assertEquals(effectsOfType(action, "spawn_dtach_session")[0].backend, "codex")
    assertEquals(action.stateChanges.chatState.commandCenter.topicBackends["55"], "codex")
})
Deno.test("backend switch persists the choice separately from the session", async () => {
    const core = makeCore({ chatState: { commandCenter: { threadMap: { "55": "Gone" } } }, chatSessions: {} })
    const action = await getHotCommands().get("backend")({ ...event, text: "/backend codex" }, core)
    assertEquals(action.stateChanges.chatState.commandCenter.topicBackends["55"], "codex")
})

import { buildRemoveSessionPatch } from "../lib/pure/session-removal.js"
Deno.test("removal migrates the backend before deleting a legacy session entry", () => {
    const patch = buildRemoveSessionPatch("Old", makeCore({ chatSessions: { Old: { backend: "codex" } }, chatState: { commandCenter: { threadMap: { "55": "Old" } } } }))
    assertEquals(patch.chatState.commandCenter.topicBackends["55"], "codex")
    assertEquals(patch.chatSessions.Old, undefined)
})
