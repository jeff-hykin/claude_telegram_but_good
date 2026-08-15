// ---------------------------------------------------------------------------
// lib/agent-backends/index.js — the agent-backend registry.
//
// One lookup table from backend name to an implementation of
// lib/agent-backends/spec.js. Everything in the daemon that used to reach
// straight for dtach or the `claude` binary goes through here instead.
//
// Two lookups matter:
//
//   backendForSession(session)  — for an EXISTING session. The session
//       records which backend spawned it at register time, so a running
//       Claude session keeps behaving like Claude even after the config
//       default flips to a local model.
//
//   defaultBackend()            — for a NEW session. Reads the
//       `agent_backend` config key.
//
// Adding a backend: write lib/agent-backends/<name>.js exporting
// `backend` (built with defineBackend), then add it to BACKEND_MODULES.
// ---------------------------------------------------------------------------

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { getConfigKey } = await versionedImport("../config-manager.js", import.meta)
const { validateBackend } = await versionedImport("./spec.js", import.meta)

// Sessions registered before the `backend` field existed (every Claude
// shim in the wild) report nothing — treat them as Claude.
export const DEFAULT_BACKEND_NAME = "claude"

const BACKEND_MODULES = {
    claude: "./claude.js",
    local: "./local-openai.js",
}

const registry = {}

for (const [name, modulePath] of Object.entries(BACKEND_MODULES)) {
    try {
        const module = await versionedImport(modulePath, import.meta)
        const backend = module.backend
        const problems = validateBackend(backend)
        if (problems.length > 0) {
            dbg("BACKEND", `${name} failed validation, not registering:`, problems.join("; "))
            continue
        }
        registry[name] = backend
    } catch (e) {
        dbg("BACKEND", `failed to load backend "${name}":`, e)
    }
}

/** All successfully loaded backends. */
export function listBackends() {
    return Object.values(registry)
}

/**
 * Look up a backend by name. Falls back to Claude (with a log line) so a
 * typo'd config value degrades to the known-good backend instead of
 * killing every spawn.
 */
export function getBackend(name) {
    const wanted = name || DEFAULT_BACKEND_NAME
    if (registry[wanted]) {
        return registry[wanted]
    }
    dbg("BACKEND", `unknown backend "${wanted}", falling back to ${DEFAULT_BACKEND_NAME}`)
    return registry[DEFAULT_BACKEND_NAME]
}

/** The backend new sessions should be spawned with. */
export function defaultBackend() {
    return getBackend(getConfigKey("agent_backend", DEFAULT_BACKEND_NAME))
}

/**
 * The backend that owns an already-running session. `session.backend` is
 * stamped at registration; absent means a pre-existing Claude session.
 */
export function backendForSession(session) {
    return getBackend(session?.backend ?? DEFAULT_BACKEND_NAME)
}
