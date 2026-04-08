/**
 * dtach session helpers: install check, create, attach, list.
 */

import { join } from "@std/path"
import { STATE_DIR } from "./protocol.ts"

function exec(cmd: string, args: string[]): { success: boolean; stdout: string; stderr: string } {
  try {
    const result = new Deno.Command(cmd, {
      args,
      stdout: "piped",
      stderr: "piped",
    }).outputSync()
    return {
      success: result.success,
      stdout: new TextDecoder().decode(result.stdout).trim(),
      stderr: new TextDecoder().decode(result.stderr).trim(),
    }
  } catch {
    return { success: false, stdout: "", stderr: "command not found" }
  }
}

export function isDtachInstalled(): boolean {
  return exec("which", ["dtach"]).success
}

/**
 * Try to install dtach using available package managers.
 * Returns true if dtach is now available.
 */
export function ensureDtach(): boolean {
  if (isDtachInstalled()) return true

  // Try nix first
  if (exec("which", ["nix"]).success) {
    console.log("Installing dtach via nix...")
    const r = exec("nix", ["profile", "install", "nixpkgs#dtach"])
    if (r.success && isDtachInstalled()) return true
  }

  // Try apt-get (Linux)
  if (Deno.build.os === "linux" && exec("which", ["apt-get"]).success) {
    console.log("Installing dtach via apt-get...")
    const r = exec("sudo", ["apt-get", "install", "-y", "dtach"])
    if (r.success && isDtachInstalled()) return true
  }

  // Try brew (macOS)
  if (exec("which", ["brew"]).success) {
    console.log("Installing dtach via brew...")
    const r = exec("brew", ["install", "dtach"])
    if (r.success && isDtachInstalled()) return true
  }

  return false
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return Array.from(arr, b => b.toString(16).padStart(2, "0")).join("")
}

export type DtachSession = {
  id: string
  socketPath: string
}

/**
 * List dtach session sockets in the state directory.
 */
export function listDtachSockets(): DtachSession[] {
  const results: DtachSession[] = []
  try {
    for (const entry of Deno.readDirSync(STATE_DIR)) {
      const m = entry.name.match(/^dtach-([a-f0-9]+)\.sock$/)
      if (m) {
        results.push({ id: m[1], socketPath: join(STATE_DIR, entry.name) })
      }
    }
  } catch { /* ignore */ }
  return results
}

/**
 * Create a new dtach session running Claude Code with telegram channel.
 * This replaces the current process (exec).
 */
export function createSession(title?: string): never {
  Deno.mkdirSync(STATE_DIR, { recursive: true })

  const sessionId = randomHex(3)
  const dtachSock = join(STATE_DIR, `dtach-${sessionId}.sock`)

  // Write session info for the shim to pick up
  const info: Record<string, string> = { id: sessionId, dtachSocket: dtachSock }
  if (title) info.title = title
  Deno.writeTextFileSync(join(STATE_DIR, "next_session.json"), JSON.stringify(info))

  console.log(`Session ID: ${sessionId}`)
  console.log(`dtach socket: ${dtachSock}`)
  console.log(`Detach with Ctrl+\\`)
  console.log()

  // exec into dtach
  const cmd = new Deno.Command("dtach", {
    args: ["-c", dtachSock, "-z", "claude", "--dangerously-skip-permissions", "--channels", "plugin:telegram@claude-plugins-official"],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  const result = cmd.outputSync()
  Deno.exit(result.code)
}

/**
 * Attach to an existing dtach session.
 */
export function attachSession(id: string): never {
  const dtachSock = join(STATE_DIR, `dtach-${id}.sock`)
  try {
    Deno.statSync(dtachSock)
  } catch {
    console.error(`No dtach socket found for session ${id}`)
    console.error(`Expected: ${dtachSock}`)
    Deno.exit(1)
  }

  const cmd = new Deno.Command("dtach", {
    args: ["-a", dtachSock],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  const result = cmd.outputSync()
  Deno.exit(result.code)
}
