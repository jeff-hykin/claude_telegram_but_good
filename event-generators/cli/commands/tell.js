import { versionedImport } from "../../../lib/version.js"

const [
    { colors },
    { dbg },
] = await Promise.all([
    versionedImport("../../../imports.js", import.meta),
    versionedImport("../../../lib/logging.js", import.meta),
])
const c = colors

export async function runTell(args) {
    if (args.length < 2) {
        console.log()
        console.log(c.bold.white("  Usage:") + c.dim(" cbg tell <target> <message>"))
        console.log()
        console.log(c.dim("  target: session ID, topic name, or title substring"))
        console.log(c.dim("  message: text to send (remaining args joined with spaces)"))
        console.log()
        console.log(c.dim("  Examples:"))
        console.log(`    ${c.cyan("cbg tell MassCapybara")} ${c.dim('"check the test failures"')}`)
        console.log(`    ${c.cyan("cbg tell cbg")} ${c.dim('"what are you working on?"')}`)
        console.log()
        Deno.exit(1)
    }

    const target = args[0]
    const text = args.slice(1).join(" ")

    const { sendCliCommand } = await versionedImport("../helpers.js", import.meta)
    let reply
    try {
        reply = await sendCliCommand("tell_session", { target, text })
    } catch (e) {
        console.error(c.red(`  ${e.message}`))
        Deno.exit(1)
    }

    if (!reply.ok) {
        console.error(c.red(`  ${reply.error}`))
        Deno.exit(1)
    }

    console.log(c.green(`  ${reply.message}`))
}
