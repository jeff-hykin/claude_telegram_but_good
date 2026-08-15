/**
 * lib/effects/spawn-dtach-session.js — spawn a fresh agent session.
 *
 * Named for what it used to do exclusively. The dtach mechanics moved to
 * lib/agent-backends/claude.js; this effect now just picks the configured
 * backend and asks it to spawn. A local-model session has no dtach socket
 * at all, and callers don't need to know which they got.
 *
 * The effect is best-effort: it logs and swallows spawn errors. Callers
 * should emit their own ipc_respond AFTER this effect to report the
 * projected session info — pid/connected fill in once the session
 * registers (~1-3 s later).
 */

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { defaultBackend } = await versionedImport("../agent-backends/index.js", import.meta)

/**
 * @param {object} effect
 * @param {string} effect.sessionId   — pre-assigned session id (PascalCase)
 * @param {string} [effect.title]     — display title for the session
 * @param {string} [effect.cwd]       — working directory for the session
 * @param {string} [effect.topicName] — if set, mkdir the topic memory
 *                                      directory so the session can write
 *                                      memory.md immediately
 * @param {string} [effect.prompt]    — initial prompt, for headless spawns
 */
export async function spawnDtachSession(effect, _core) {
    const { sessionId, title, cwd, topicName, prompt } = effect
    const backend = defaultBackend()
    const result = await backend.spawn({ sessionId, title, cwd, topicName, prompt })
    if (!result.ok) {
        dbg("SPAWN-SESSION", `${backend.name} spawn failed for ${sessionId}: ${result.detail}`)
    }
}
