// Serialize active-turn steering and keep rejected/racing input for the next turn.
// This queue owns input until turn/steer acknowledges it; finishing a turn must
// wait for that acknowledgement before draining the next turn's input.
export class CodexInputQueue {
    constructor({ request, onQueued = () => {}, onError = () => {} }) {
        this.request = request
        this.onQueued = onQueued
        this.onError = onError
        this.pending = []
        this.active = null
        this.inFlight = null
        this.blockedTurn = null
    }

    get length() { return this.pending.length }

    enqueue(text, steer = true) {
        this.pending.push({ text, steer })
        this.onQueued()
        this.pump()
    }

    setActive(threadId, turnId) {
        this.active = { threadId, turnId }
        this.pump()
    }

    clearActive() { this.active = null }

    async takeBatch() {
        // A turn may end while its steer request is still being answered.
        // Wait so a rejected message cannot arrive behind the next turn.
        while (this.inFlight) { await this.inFlight }
        return this.pending.splice(0).map((entry) => entry.text).join("\n\n")
    }

    pump() {
        const active = this.active
        if (!active || this.inFlight || this.blockedTurn === active.turnId || !this.pending[0]?.steer) { return }
        let count = 0
        while (this.pending[count]?.steer) { count++ }
        const batch = this.pending.splice(0, count)
        this.inFlight = Promise.resolve().then(() => this.request("turn/steer", {
            threadId: active.threadId,
            expectedTurnId: active.turnId,
            input: [{ type: "text", text: batch.map((entry) => entry.text).join("\n\n") }],
        }, 30_000)).catch((error) => {
            this.pending.unshift(...batch)
            this.blockedTurn = active.turnId
            this.onError(error)
            this.onQueued()
        }).finally(() => {
            this.inFlight = null
            this.pump()
        })
    }
}
