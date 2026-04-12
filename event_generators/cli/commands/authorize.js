import { versionedImport } from "../../../lib/version.js"

const [{ colors, join }, { STATE_DIR }] = await Promise.all([
    versionedImport("../../../imports.js", import.meta),
    versionedImport("../../../lib/protocol.js", import.meta),
])
const c = colors

export function runAuthorize(_args) {
    const otp = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, "0")).join("")
    const otpFile = join(STATE_DIR, "pending_otp.json")
    Deno.mkdirSync(STATE_DIR, { recursive: true })
    Deno.writeTextFileSync(otpFile, JSON.stringify({ code: otp }))
    console.log()
    console.log(c.bold.white("  Pairing code generated."))
    console.log()
    console.log(c.dim("  Have the new user send this to your bot on Telegram:"))
    console.log()
    console.log(c.bold.cyan(`    /approve_user one_time_password:${otp}`))
    console.log()
}
