import { versionedImport } from "../../../lib/version.js"

const [
    { colors },
    { readLatestInboxMessage, readInboxMessages, inboxExists },
] = await Promise.all([
    versionedImport("../../../imports.js", import.meta),
    versionedImport("../../../lib/inbox.js", import.meta),
])
const c = colors

export async function runInbox(args) {
    if (args.length < 2) {
        console.log()
        console.log(c.bold.white("  Usage:") + c.dim(" cbg inbox <subcommand> <address>"))
        console.log()
        console.log(c.dim("  Subcommands:"))
        console.log(`    ${c.cyan("latest <address>")}    ${c.dim("Print the latest message (JSON)")}`)
        console.log(`    ${c.cyan("last <N> <address>")}  ${c.dim("Print the last N messages (JSON array)")}`)
        console.log(`    ${c.cyan("exists <address>")}    ${c.dim("Check if an inbox exists (exit 0/1)")}`)
        console.log()
        console.log(c.dim("  Address examples:"))
        console.log(`    ${c.cyan("QualifiedBandicoot")}  ${c.dim("— session inbox")}`)
        console.log(`    ${c.cyan("topic:cbg")}           ${c.dim("— topic inbox")}`)
        console.log(`    ${c.cyan("my_script")}           ${c.dim("— CLI inbox")}`)
        console.log()
        Deno.exit(1)
    }

    const sub = args[0]

    if (sub === "latest") {
        const address = args[1]
        if (!address) {
            console.error(c.red("  Missing address"))
            Deno.exit(1)
        }
        const msg = readLatestInboxMessage(address)
        if (!msg) {
            console.error(c.red(`  No messages in inbox "${address}"`))
            Deno.exit(1)
        }
        console.log(JSON.stringify(msg, null, 2))
    } else if (sub === "last") {
        const count = parseInt(args[1], 10)
        const address = args[2]
        if (!address || isNaN(count)) {
            console.error(c.red("  Usage: cbg inbox last <N> <address>"))
            Deno.exit(1)
        }
        const msgs = readInboxMessages(address, count)
        console.log(JSON.stringify(msgs, null, 2))
    } else if (sub === "exists") {
        const address = args[1]
        if (!address) {
            console.error(c.red("  Missing address"))
            Deno.exit(1)
        }
        if (inboxExists(address)) {
            console.log("true")
            Deno.exit(0)
        } else {
            console.log("false")
            Deno.exit(1)
        }
    } else {
        console.error(c.red(`  Unknown subcommand: ${sub}`))
        Deno.exit(1)
    }
}
