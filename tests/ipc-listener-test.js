import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { setupTempPaths } from "./_helpers.js"
import { versionedImport } from "../lib/version.js"

setupTempPaths("cbg-ipc-listener-test-")
const { acceptIpcConnections } = await versionedImport("../lib/ipc-listener.js", import.meta)

Deno.test("IPC replaces an EINVAL listener and accepts new sessions despite a failed rebind", async () => {
    let stopped = false
    let closed = 0
    let attempts = 0
    const received = []
    const conn = { session: "codex" }
    await acceptIpcConnections({
        listener: {
            accept() { throw new TypeError("Invalid argument (os error 22)") },
            close() { closed++ },
        },
        reopen() {
            attempts++
            if (attempts === 1) { throw new Error("temporarily cannot bind") }
            return { accept() { return conn } }
        },
        onConnection(value) { received.push(value); stopped = true },
        isStopping: () => stopped,
        sleep: () => Promise.resolve(),
    })
    assertEquals(closed, 1)
    assertEquals(attempts, 2)
    assertEquals(received, [conn])
})

Deno.test("IPC shutdown does not recreate a deliberately closed listener", async () => {
    let stopped = false
    let reopened = 0
    await acceptIpcConnections({
        listener: {
            accept() { stopped = true; throw new Deno.errors.BadResource("closed") },
        },
        reopen() { reopened++ },
        onConnection() { throw new Error("unexpected connection") },
        isStopping: () => stopped,
    })
    assertEquals(reopened, 0)
})
