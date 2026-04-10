/**
 * Daemon management: systemd (Linux) and launchd (macOS).
 * Handles creating, starting, stopping the standalone Telegram server as a service.
 */

import { join } from "../imports.js"
import { HOME, LOCAL_REPO, dbg } from "./protocol.js"
const IS_MACOS = Deno.build.os === "darwin"
const SERVICE_NAME = "cbg-telegram"

function denoPath() {
    const result = new Deno.Command("which", {
        args: ["deno"],
        stdout: "piped",
        stderr: "null",
    }).outputSync()
    return new TextDecoder().decode(result.stdout).trim()
}

function serverScriptPath() {
    return join(LOCAL_REPO, "standalone-server.js")
}

// === systemd (Linux) ===

function systemdUnitPath() {
    return join(HOME, ".config", "systemd", "user", `${SERVICE_NAME}.service`)
}

function systemdUnitContent() {
    const deno = denoPath()
    const script = serverScriptPath()
    return `[Unit]
Description=CBG Telegram Server
After=network-online.target

[Service]
Type=simple
ExecStart=${deno} run -A ${script}
Restart=always
RestartSec=5
KillMode=control-group
Environment=HOME=${HOME}
Environment=PATH=${Deno.env.get("PATH") ?? "/usr/local/bin:/usr/bin:/bin"}

[Install]
WantedBy=default.target
`
}

function systemdInstall() {
    const unitPath = systemdUnitPath()
    Deno.mkdirSync(join(HOME, ".config", "systemd", "user"), { recursive: true })
    Deno.writeTextFileSync(unitPath, systemdUnitContent())
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

function launchdPlistPath() {
    return join(HOME, "Library", "LaunchAgents", "com.cbg.telegram.plist")
}

function launchdPlistContent() {
    const deno = denoPath()
    const script = serverScriptPath()
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.cbg.telegram</string>
  <key>ProgramArguments</key>
  <array>
    <string>${deno}</string>
    <string>run</string>
    <string>-A</string>
    <string>${script}</string>
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${HOME}</string>
    <key>PATH</key>
    <string>${Deno.env.get("PATH") ?? "/usr/local/bin:/usr/bin:/bin"}</string>
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
        Deno.mkdirSync(join(HOME, "Library", "LaunchAgents"), { recursive: true })
        Deno.writeTextFileSync(launchdPlistPath(), launchdPlistContent())
    } else {
        systemdInstall()
    }
}

export function startService() {
    installService()
    if (IS_MACOS) {
        return launchdExec(["load", launchdPlistPath()])
    } else {
        systemdExec(["daemon-reload"])
        return systemdExec(["enable", "--now", SERVICE_NAME])
    }
}

export function stopService() {
    if (IS_MACOS) {
        return launchdExec(["unload", launchdPlistPath()])
    } else {
        return systemdExec(["stop", SERVICE_NAME])
    }
}

export function restartService() {
    installService()
    if (IS_MACOS) {
        launchdExec(["unload", launchdPlistPath()])
        return launchdExec(["load", launchdPlistPath()])
    } else {
        systemdExec(["daemon-reload"])
        return systemdExec(["restart", SERVICE_NAME])
    }
}

export function serviceStatus() {
    if (IS_MACOS) {
        return launchdExec(["list", "com.cbg.telegram"])
    } else {
        return systemdExec(["status", SERVICE_NAME])
    }
}

export function removeService() {
    stopService()
    if (IS_MACOS) {
        try { Deno.removeSync(launchdPlistPath()) } catch (e) { dbg("DAEMON", "remove plist:", e) }
    } else {
        systemdExec(["disable", SERVICE_NAME])
        try { Deno.removeSync(systemdUnitPath()) } catch (e) { dbg("DAEMON", "remove unit:", e) }
        systemdExec(["daemon-reload"])
    }
}

export function isServiceInstalled() {
    try {
        if (IS_MACOS) {
            Deno.statSync(launchdPlistPath())
        } else {
            Deno.statSync(systemdUnitPath())
        }
        return true
    } catch {
        return false
    }
}
