/**
 * Daemon management: systemd (Linux) and launchd (macOS).
 *
 * Registers main-server.js as a user-level background service so the
 * CBG daemon survives terminal closures.
 */

import { versionedImport } from "./version.js"

const { dbg } = await versionedImport("./logging.js", import.meta)
const { paths } = await versionedImport("./paths.js", import.meta)
// Reused as an XML-text escape: &, <, > — which is exactly what
// <string>...</string> content in a plist needs.
const { escapeHtml: xmlEscape } = await versionedImport("./pure/html.js", import.meta)

const IS_MACOS = Deno.build.os === "darwin"

/**
 * Quote a value for a systemd unit-file line. Wraps in double quotes and
 * escapes the two characters systemd treats specially inside double quotes:
 * backslash and double-quote (per systemd.syntax(7)). Rejects newlines —
 * unit-file values must fit on a single line and a newline-containing path
 * is a broken env, so fail loudly rather than silently produce a malformed
 * unit file.
 *
 * Used for ExecStart argv entries and Environment= values so spaces in
 * paths (e.g. /Users/Bob Smith/...) don't split into multiple arguments.
 */
function systemdQuote(value) {
    const str = String(value)
    if (/[\r\n]/.test(str)) {
        throw new Error(
            `systemd unit value contains a newline and cannot be safely written: ${JSON.stringify(str)}`,
        )
    }
    return `"${str.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

export function isDaemonRunning() {
    try {
        const pid = parseInt(Deno.readTextFileSync(paths.PID_FILE).trim())
        if (pid > 0) {
            const r = new Deno.Command("kill", {
                args: ["-0", String(pid)],
                stdout: "null",
                stderr: "null",
            }).outputSync()
            return r.success
        }
    } catch (e) {
        dbg("DAEMON", "isDaemonRunning check failed:", e)
    }
    return false
}

// === systemd (Linux) ===

function systemdUnitContent() {
    const deno = Deno.execPath()
    const pathEnv = Deno.env.get("PATH") ?? "/usr/local/bin:/usr/bin:/bin"
    return `[Unit]
Description=CBG Telegram Server
After=network-online.target

[Service]
Type=simple
ExecStart=${systemdQuote(deno)} run -A ${systemdQuote(paths.MAIN_SERVER_JS)}
Restart=always
RestartSec=5
KillMode=process
Environment=HOME=${systemdQuote(paths.HOME)}
Environment=PATH=${systemdQuote(pathEnv)}

[Install]
WantedBy=default.target
`
}

function systemdInstall() {
    Deno.mkdirSync(paths.SYSTEMD_USER_DIR, { recursive: true })
    Deno.writeTextFileSync(paths.SYSTEMD_SERVICE_FILE, systemdUnitContent())
}

function systemdExec(args) {
    const result = new Deno.Command("systemctl", {
        args: ["--user", ...args],
        stdout: "piped",
        stderr: "piped",
    }).outputSync()
    return new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr)
}

// === launchd (macOS) ===

function launchdPlistContent() {
    const deno = Deno.execPath()
    const pathEnv = Deno.env.get("PATH") ?? "/usr/local/bin:/usr/bin:/bin"
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(paths.LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(deno)}</string>
    <string>run</string>
    <string>-A</string>
    <string>${xmlEscape(paths.MAIN_SERVER_JS)}</string>
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xmlEscape(paths.HOME)}</string>
    <key>PATH</key>
    <string>${xmlEscape(pathEnv)}</string>
  </dict>
</dict>
</plist>
`
}

function launchdExec(args) {
    const result = new Deno.Command("launchctl", {
        args,
        stdout: "piped",
        stderr: "piped",
    }).outputSync()
    return new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr)
}

// === Public API ===

export function installService() {
    if (IS_MACOS) {
        Deno.mkdirSync(paths.LAUNCHD_AGENTS_DIR, { recursive: true })
        Deno.writeTextFileSync(paths.LAUNCHD_PLIST_FILE, launchdPlistContent())
    } else {
        systemdInstall()
    }
}

export function startService() {
    installService()
    if (IS_MACOS) {
        return launchdExec(["load", paths.LAUNCHD_PLIST_FILE])
    }
    systemdExec(["daemon-reload"])
    return systemdExec(["enable", "--now", paths.SERVICE_NAME])
}

export function stopService() {
    if (IS_MACOS) {
        return launchdExec(["unload", paths.LAUNCHD_PLIST_FILE])
    }
    return systemdExec(["stop", paths.SERVICE_NAME])
}

export function restartService() {
    installService()
    if (IS_MACOS) {
        launchdExec(["unload", paths.LAUNCHD_PLIST_FILE])
        return launchdExec(["load", paths.LAUNCHD_PLIST_FILE])
    }
    systemdExec(["daemon-reload"])
    return systemdExec(["restart", paths.SERVICE_NAME])
}

export function serviceStatus() {
    if (IS_MACOS) {
        return launchdExec(["list", paths.LAUNCHD_LABEL])
    }
    return systemdExec(["status", paths.SERVICE_NAME])
}

export function removeService() {
    stopService()
    if (IS_MACOS) {
        try { Deno.removeSync(paths.LAUNCHD_PLIST_FILE) } catch (e) { dbg("DAEMON", "remove plist:", e) }
    } else {
        systemdExec(["disable", paths.SERVICE_NAME])
        try { Deno.removeSync(paths.SYSTEMD_SERVICE_FILE) } catch (e) { dbg("DAEMON", "remove unit:", e) }
        systemdExec(["daemon-reload"])
    }
}

export function isServiceInstalled() {
    try {
        const target = IS_MACOS ? paths.LAUNCHD_PLIST_FILE : paths.SYSTEMD_SERVICE_FILE
        Deno.statSync(target)
        return true
    } catch (e) {
        dbg("DAEMON", "isServiceInstalled: not installed:", e)
        return false
    }
}
