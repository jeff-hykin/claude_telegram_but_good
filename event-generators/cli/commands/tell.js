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
    // --que can appear anywhere: filter it out of the positional args.
    const queueUntilIdle = args.includes("--que") || args.includes("--queue")
    const positional = args.filter(a => a !== "--que" && a !== "--queue")

    if (positional.length < 2) {
        console.log()
        console.log(c.bold.white("  Usage:") + c.dim(" cbg tell [--que] <target> <message>"))
        console.log()
        console.log(c.dim("  target:  session ID, topic name, or title substring"))
        console.log(c.dim("  message: text to send (remaining args joined with spaces)"))
        console.log(c.dim("  --que:   queue the message and deliver after the agent's"))
        console.log(c.dim("           current turn finishes (Stop hook). If the agent"))
        console.log(c.dim("           is already idle, delivers immediately."))
        console.log()
        console.log(c.dim("  Examples:"))
        console.log(`    ${c.cyan("cbg tell MassCapybara")} ${c.dim('"check the test failures"')}`)
        console.log(`    ${c.cyan("cbg tell --que cbg")} ${c.dim('"after this turn: run all tests"')}`)
        console.log()
        Deno.exit(1)
    }

    const target = positional[0]
    const text = positional.slice(1).join(" ")

    const { sendCliCommand } = await versionedImport("../helpers.js", import.meta)
    let reply
    try {
        reply = await sendCliCommand("tell_session", { target, text, queueUntilIdle })
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
