// ---------------------------------------------------------------------------
// event-generators/agent-runner/model-client.js — OpenAI-compatible chat
// client, aimed at LM Studio's local /v1 server.
//
// LM Studio speaks the OpenAI chat-completions API including `tools` and
// `tool_calls`, so there is no Qwen-specific parsing here — the model is
// asked for structured tool calls and the server does the decoding. That
// is the whole reason this backend does not need any of the output
// scraping Claude's TUI requires.
//
// The one Qwen-ism worth knowing: some GGUF builds emit tool calls as a
// text blob (```json {"name": ..., "arguments": ...}```) when the server
// can't grammar-constrain them. `salvageToolCall` catches that shape so a
// mis-templated model degrades to "the tool still runs" instead of the
// agent silently narrating what it would have done.
// ---------------------------------------------------------------------------

import { dbg } from "../../lib/logging.js"

/** Extract a tool call from an assistant message that emitted one as prose. */
function salvageToolCall(content) {
    if (typeof content !== "string") { return null }
    const fenced = content.match(/```(?:json|tool_call)?\s*(\{[\s\S]*?\})\s*```/)
    const raw = fenced ? fenced[1] : null
    if (!raw) { return null }
    let parsed
    try {
        parsed = JSON.parse(raw)
    } catch (e) {
        dbg("RUNNER-MODEL", "salvage parse failed:", e)
        return null
    }
    const name = parsed.name ?? parsed.tool ?? parsed.function?.name
    if (!name) { return null }
    const args = parsed.arguments ?? parsed.parameters ?? parsed.function?.arguments ?? {}
    return [{
        id: `salvaged-${Date.now()}`,
        type: "function",
        function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
    }]
}

export class ModelClient {
    constructor({ baseUrl, model, apiKey, temperature, maxTokens, requestTimeoutMs }) {
        this.baseUrl = String(baseUrl).replace(/\/+$/, "")
        this.model = model
        this.apiKey = apiKey
        this.temperature = temperature
        this.maxTokens = maxTokens
        this.requestTimeoutMs = requestTimeoutMs
    }

    async listModels() {
        const response = await fetch(`${this.baseUrl}/models`, {
            headers: { authorization: `Bearer ${this.apiKey}` },
        })
        if (!response.ok) {
            throw new Error(`GET /models returned ${response.status}`)
        }
        const body = await response.json()
        return (body.data ?? []).map((entry) => entry.id)
    }

    /**
     * One chat-completions round trip.
     *
     * @param {object[]} messages — OpenAI message array
     * @param {object[]} tools — OpenAI tool schema array
     * @param {AbortSignal} [signal] — aborted when the user interrupts
     * @returns {Promise<{content: string, toolCalls: object[]}>}
     */
    async complete(messages, tools, signal) {
        const timeout = AbortSignal.timeout(this.requestTimeoutMs)
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout

        const response = await fetch(`${this.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${this.apiKey}`,
            },
            signal: combined,
            body: JSON.stringify({
                model: this.model,
                messages,
                tools: tools.length > 0 ? tools : undefined,
                tool_choice: tools.length > 0 ? "auto" : undefined,
                temperature: this.temperature,
                max_tokens: this.maxTokens,
                stream: false,
            }),
        })

        if (!response.ok) {
            const detail = await response.text()
            throw new Error(`chat/completions ${response.status}: ${detail.slice(0, 500)}`)
        }

        const body = await response.json()
        const message = body.choices?.[0]?.message ?? {}
        const content = message.content ?? ""
        const toolCalls = message.tool_calls?.length > 0
            ? message.tool_calls
            : (salvageToolCall(content) ?? [])
        return { content, toolCalls }
    }
}
