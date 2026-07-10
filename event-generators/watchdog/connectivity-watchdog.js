#!/usr/bin/env -S deno run -A
// ---------------------------------------------------------------------------
// connectivity-watchdog.js — backup macOS watchdog for the cbg daemon.
//
// Installed as a separate launchd agent (com.cbg.connectivity-watchdog) that
// fires once an hour via StartInterval. Its ONLY job: if the daemon hasn't
// processed a Telegram message from an allowed sender in over an hour, run
// `cbg restart` to bring it back.
//
// The heartbeat file ($CBG_DIR/state/last-connectivity) is rewritten with the
// current epoch-ms by lib/event-handlers/chat-user.js on every inbound
// message it processes. If the daemon's event loop is wedged or dead, it can't
// process messages, so the timestamp goes stale and this watchdog restarts it.
//
// Deliberately self-contained: NO esm.sh / imports.js dependencies, so this
// safety net keeps working even if the repo's import graph is broken.
// ---------------------------------------------------------------------------

const HOME = Deno.env.get("HOME")
const cbgDir = Deno.env.get("CBG_DIR") ?? `${HOME}/.local/share/cbg`
const lastConnectivityFile = `${cbgDir}/state/last-connectivity`
const cbgBinary = `${HOME}/.deno/bin/cbg`
const ONE_HOUR_MS = 60 * 60 * 1000

function log(message) {
    console.log(`[${new Date().toISOString()}] connectivity-watchdog: ${message}`)
}

let lastConnectivity = 0
try {
    lastConnectivity = parseInt(Deno.readTextFileSync(lastConnectivityFile).trim(), 10)
} catch (error) {
    log(`could not read ${lastConnectivityFile}: ${error.message}`)
}

// No valid heartbeat yet (fresh install, never messaged). Do nothing rather
// than restart-loop on a daemon that may be perfectly healthy.
if (!Number.isFinite(lastConnectivity) || lastConnectivity <= 0) {
    log("no valid connectivity timestamp — skipping restart")
    Deno.exit(0)
}

const ageMs = Date.now() - lastConnectivity
const ageSeconds = Math.round(ageMs / 1000)

if (ageMs <= ONE_HOUR_MS) {
    log(`last connectivity ${ageSeconds}s ago — healthy, no restart`)
    Deno.exit(0)
}

log(`last connectivity ${ageSeconds}s ago (> 1h) — running cbg restart`)
try {
    const result = new Deno.Command(cbgBinary, {
        args: ["restart"],
        stdout: "piped",
        stderr: "piped",
    }).outputSync()
    const stdout = new TextDecoder().decode(result.stdout).trim()
    const stderr = new TextDecoder().decode(result.stderr).trim()
    if (stdout) { log(`stdout: ${stdout}`) }
    if (stderr) { log(`stderr: ${stderr}`) }
    log(`cbg restart exited with code ${result.code}`)
    Deno.exit(result.success ? 0 : 1)
} catch (error) {
    log(`failed to run ${cbgBinary} restart: ${error.message}`)
    Deno.exit(1)
}
