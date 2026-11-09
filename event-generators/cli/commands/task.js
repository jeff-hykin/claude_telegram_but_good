// `cbg task list` / `cbg task cancel <id>`
//
// The long-task helpers (/task_status_, /task_cancel_, …) are Telegram
// commands, so until now a task could only be inspected or cleared by the
// user tapping a link in a chat. That left a session debugging the task
// system able to read the wreckage but not clear it, and left no way to
// cancel a task from a script. Both subcommands go through the daemon so
// they share the chat commands' definition of what cancelling means.

import { versionedImport } from "../../../lib/version.js"

const [
    { colors },
] = await Promise.all([
    versionedImport("../../../imports.js", import.meta),
])
const c = colors

function usage() {
    console.log()
    console.log(c.bold.white("  Usage:") + c.dim(" cbg task <list|cancel> [id]"))
    console.log()
    console.log(c.dim("  list            show every long task the daemon knows about"))
    console.log(c.dim("  cancel <id>     cancel a long task (same as /task_cancel_<id>)"))
    console.log()
    console.log(c.dim("  Examples:"))
    console.log(`    ${c.cyan("cbg task list")}`)
    console.log(`    ${c.cyan("cbg task cancel PremierThrush")}`)
    console.log()
}

export async function runTask(args) {
    const sub = args[0]
    if (sub !== "list" && sub !== "cancel") {
        usage()
        Deno.exit(1)
    }

    const { sendCliCommand } = await versionedImport("../helpers.js", import.meta)

    if (sub === "list") {
        let reply
        try {
            reply = await sendCliCommand("list_long_tasks", {})
        } catch (e) {
            console.log(c.red(`  ✖ ${e.message}`))
            Deno.exit(1)
        }
        if (!reply?.ok) {
            console.log(c.red(`  ✖ ${reply?.error ?? "daemon refused"}`))
            Deno.exit(1)
        }
        const tasks = reply.tasks ?? []
        if (tasks.length === 0) {
            console.log(c.dim("  no long tasks"))
            return
        }
        console.log()
        for (const t of tasks) {
            const orphan = t.orphanedSince ? c.yellow(" orphaned") : ""
            console.log(
                `  ${c.cyan(t.id.padEnd(22))} ${String(t.state ?? "?").padEnd(12)} ` +
                `${c.dim("worker=")}${t.workerSessionId ?? "-"}${orphan}`,
            )
            if (t.title) {
                console.log(`  ${" ".repeat(22)} ${c.dim(t.title)}`)
            }
        }
        console.log()
        return
    }

    const taskId = args[1]
    if (!taskId) {
        usage()
        Deno.exit(1)
    }
    let reply
    try {
        reply = await sendCliCommand("cancel_long_task", { taskId })
    } catch (e) {
        console.log(c.red(`  ✖ ${e.message}`))
        Deno.exit(1)
    }
    if (!reply?.ok) {
        console.log(c.red(`  ✖ ${reply?.error ?? "daemon refused"}`))
        Deno.exit(1)
    }
    console.log(c.green(`  ✔ cancelled ${taskId}`) + c.dim(` (resume with /task_resume_${taskId})`))
}
