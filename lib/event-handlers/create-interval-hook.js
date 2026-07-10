// lib/event-handlers/create-interval-hook.js
//
// Handler for the create_interval_hook MCP tool. An interval hook is an
// agent-written JS decision function that runs on a recurring interval.
// Each run the function returns null (do nothing) or a string (message
// the target topic's agent). The JS file is cbg-managed (lives under
// $CBG_DIR/interval-hooks/<id>/, NOT in the repo). This handler writes
// hook.js + config.json, arms the first fire, and replies to the caller.

import { versionedImport } from "../version.js"

const { dbg } = await versionedImport("../logging.js", import.meta)
const { paths } = await versionedImport("../paths.js", import.meta)
const { validateRule } = await versionedImport("../scheduler/index.js", import.meta)
const { intervalHookCommandLinks } = await versionedImport("../interval-hook-actions.js", import.meta)
const { randomHex } = await versionedImport("../pure/ids.js", import.meta)
const { replyToForSession, sendEffect } = await versionedImport("../pure/reply-to.js", import.meta)
const { loadAccess } = await versionedImport("../access.js", import.meta)

function replyError(event, message) {
    return {
        effects: [{
            type: "ipc_respond",
            conn: event._conn,
            message: {
                type: "tool_response",
                requestId: event.requestId,
                result: {
                    content: [{ type: "text", text: message }],
                    isError: true,
                },
            },
        }],
    }
}

function generateUniqueHookId(core) {
    const existing = new Set()
    const byChat = core.specialData?.intervalHookByChatId ?? {}
    for (const hooks of Object.values(byChat)) {
        for (const id of Object.keys(hooks ?? {})) { existing.add(id) }
    }
    let id
    do { id = `ih_${randomHex(3)}` } while (existing.has(id))
    return id
}

export default function handle(event, core) {
    const { title, topic, rule, code, timeoutMs } = event

    if (!topic || typeof topic !== "string" || !topic.trim()) {
        return replyError(event, "topic is required (the Telegram topic name to message)")
    }
    if (typeof code !== "string" || !code.trim()) {
        return replyError(event, "code is required (JS source that default-exports the decision function)")
    }
    if (!/export\s+default/.test(code)) {
        return replyError(event, "code must contain a default export (the decision function)")
    }
    if (!rule || typeof rule !== "object") {
        return replyError(event, "rule is required and must be an object")
    }
    const check = validateRule(rule)
    if (!check.ok) {
        dbg("CREATE-IHOOK", `invalid rule: ${check.error}`)
        return replyError(event, `invalid rule: ${check.error}`)
    }

    // Owner chat: first allowFrom user (this tool may be called from a
    // session that has never sent a Telegram message).
    const access = loadAccess()
    const chatId = (access.allowFrom ?? [])[0] ?? "cli"

    const hookId = generateUniqueHookId(core)
    const createdAt = new Date().toISOString()
    const cleanTimeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : null

    const newHook = {
        id: hookId,
        title: (title ?? topic).trim(),
        topic: topic.trim(),
        createdAt,
        active: true,
        rule,
        timeoutMs: cleanTimeout,
        tracking: {
            totalRuns: 0,
            lastRunAt: null,
            lastRunStatus: null,
            lastResult: null,
            nextFireAt: null,
            skipNext: false,
            runHistory: [],
        },
        currentRun: null,
    }

    const hookDir = paths.intervalHookDir(hookId)
    const hookFile = paths.intervalHookFile(hookId)
    const configFile = paths.intervalHookConfigFile(hookId)

    dbg("CREATE-IHOOK", `creating interval hook ${hookId} ("${newHook.title}") → topic "${topic}"`)

    return {
        stateChanges: {
            specialData: {
                intervalHookByChatId: {
                    [chatId]: { [hookId]: newHook },
                },
            },
        },
        effects: [
            { type: "mkdir", path: hookDir },
            { type: "write_file", path: hookFile, content: code },
            {
                type: "write_file",
                path: configFile,
                content: JSON.stringify({
                    id: hookId,
                    title: newHook.title,
                    topic: newHook.topic,
                    rule,
                    timeoutMs: cleanTimeout,
                    createdAt,
                }, null, 2),
            },
            {
                type: "cold_append",
                stream: "interval-hooks",
                entry: { hookId, chatId, event: "created", topic: newHook.topic, sessionId: event.sessionId },
            },
            { type: "interval_hook_timer_set", chatId, hookId, rule },
            {
                type: "ipc_respond",
                conn: event._conn,
                message: {
                    type: "tool_response",
                    requestId: event.requestId,
                    result: {
                        content: [{
                            type: "text",
                            text: `Interval hook ${hookId} created and armed. Title: "${newHook.title}", topic: "${newHook.topic}". ` +
                                `The JS lives at ${hookFile}. Deactivate with the deactivate_interval_hook tool or /interval_hook_off_${hookId}.`,
                        }],
                    },
                },
            },
            sendEffect(
                replyToForSession(event.sessionId, core, "create-interval-hook", chatId),
                `Interval hook ${hookId} created → topic ${newHook.topic}: ${newHook.title}\n\n` +
                intervalHookCommandLinks(hookId),
                {},
            ),
        ],
    }
}
