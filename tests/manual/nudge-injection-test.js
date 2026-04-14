// tests/manual/nudge-injection-test.js
//
// One-shot live test of the new dtach-outbound sendTextToClaude flow
// (two-write Push with a 120ms sleep between text and Enter).
//
// Plan:
//   1. Make a temp dir for the dtach socket + log.
//   2. Spawn `claude --no-tele` wrapped in dtach -c, tee the pty output
//      to a log file. Run in the background with piped stdin so it
//      doesn't fight with this script for a terminal.
//   3. Wait for claude to render its first frame.
//   4. Call the same two-step pushToDtach dance shipped in
//      lib/effects/dtach-outbound.js: write "say hi", sleep 120ms, write
//      a bare 0x0d (Enter).
//   5. Wait for claude to respond.
//   6. Replay the dtach log through tui-render.js, write a sanitized
//      screen dump to /tmp/nudge-test.screen, and print the tail so we
//      can see whether claude actually submitted the turn.
//
// Run:
//   deno run --allow-all tests/manual/nudge-injection-test.js [claude-bin]

import { renderTui, trimTrailingMarker } from "../../lib/pure/tui-render.js"

const claudeBin = Deno.args[0] ?? "claude"

const SUBMIT_DELAY_MS = 120
const ENTER_KEYSTROKE = new Uint8Array([0x0d])

async function pushToDtach(dtachSocket, bytes) {
    const p = new Deno.Command("dtach", {
        args: ["-p", dtachSocket],
        stdin: "piped",
        stdout: "null",
        stderr: "null",
    }).spawn()
    const w = p.stdin.getWriter()
    await w.write(bytes)
    await w.close()
    await p.status
}

async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

async function dumpScreen(log, label) {
    const raw = await Deno.readTextFile(log)
    const ingested = raw.split(/\r?\n/).slice(-3000).join("\n")
    const rendered = renderTui(ingested, { width: 80, height: 60, ansi: false, trim: true })
    const trimmed = trimTrailingMarker(rendered)
    const sanitized = trimmed
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
        .replace(/\x1b/g, "")
    const outPath = `/tmp/nudge-test-${label}.screen`
    await Deno.writeTextFile(outPath, sanitized)
    return { path: outPath, sanitized, rawBytes: raw.length }
}

const socketDir = await Deno.makeTempDir({ prefix: "cbg-nudge-test-" })
const sock = `${socketDir}/sess.sock`
const log = `${socketDir}/sess.log`
console.log(`socket: ${sock}`)
console.log(`log:    ${log}`)

// Spawn dtach wrapped in BSD `script -q` so dtach inherits a real pty
// (dtach -c refuses to start without a controlling terminal, and we
// don't want to donate our own — we need stdin free to be null so the
// test process stays non-interactive). `script -q <file> <cmd...>`
// runs cmd with its stdio attached to a freshly-allocated pty and
// records that pty's output to <file>. That file IS our dtach log.
const shimProc = new Deno.Command("script", {
    args: ["-q", log, "dtach", "-c", sock, "-z", claudeBin, "--no-tele"],
    stdin: "null",
    stdout: "null",
    stderr: "null",
}).spawn()

console.log("spawned dtach-wrapped claude. waiting 6s for first render...")
await sleep(6000)

const before = await dumpScreen(log, "before")
console.log(`before injection: wrote ${before.path} (${before.rawBytes} raw bytes)`)
console.log(`--- tail of BEFORE ---`)
console.log(before.sanitized.split("\n").slice(-15).join("\n"))
console.log(`--- end BEFORE ---\n`)

console.log('injecting "say hi" via two-step dtach -p...')
await pushToDtach(sock, new TextEncoder().encode("say hi"))
await sleep(SUBMIT_DELAY_MS)
await pushToDtach(sock, ENTER_KEYSTROKE)
console.log("injection complete. waiting 10s for claude to reply...")
await sleep(10000)

const after = await dumpScreen(log, "after")
console.log(`after injection: wrote ${after.path} (${after.rawBytes} raw bytes)`)
console.log(`--- tail of AFTER ---`)
console.log(after.sanitized.split("\n").slice(-30).join("\n"))
console.log(`--- end AFTER ---\n`)

console.log("cleaning up: sending Ctrl+C Ctrl+C Ctrl+D to gracefully quit claude...")
try {
    await pushToDtach(sock, new Uint8Array([0x03])) // Ctrl+C
    await sleep(200)
    await pushToDtach(sock, new Uint8Array([0x03]))
    await sleep(200)
    await pushToDtach(sock, new Uint8Array([0x04])) // Ctrl+D
} catch (e) {
    console.log(`cleanup dtach -p failed (probably already exited):`, e.message)
}

try {
    await shimProc.status
} catch (e) {
    console.log("shim process already gone:", e.message)
}

console.log("\nDONE")
console.log(`Inspect: cat ${after.path}`)
console.log(`Or diff: diff ${before.path} ${after.path}`)
