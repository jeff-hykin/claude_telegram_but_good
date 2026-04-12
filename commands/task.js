import { join } from "../imports.js"
import {
    generateTaskId, slugify, createTask, readTask,
    findActiveTaskForSession, listAllTasks, getDefinition,
    taskPath, appendLog,
} from "../lib/long-task.js"
import { getHttpPort } from "../lib/long-task-http.js"
import { HOME, dbg } from "../lib/protocol.js"

function esc(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
}

async function tail(filePath, n) {
    try {
        const raw = await Deno.readTextFile(filePath)
        const lines = raw.split("\n")
        return lines.slice(-n).join("\n")
    } catch (e) {
        dbg("TASK-CMD", "tail failed for", filePath, e)
        return null
    }
}

export const tips = [
    "/task starts a long-running task on the focused session.",
    "Use /task_list to see all tasks and their states.",
]

export const descriptions = {
    task: "Start a long-running task on the focused session",
    task_list: "List all long-running tasks",
    task_show: "Show details for a task: /task_show &lt;id&gt;",
}

export const commands = {
    task: async (ctx, bot, state) => {
        const text = ctx.message?.text || ""
        const description = text.replace(/^\/task\s*/, "").trim()
        if (!description) {
            await ctx.reply(
                "Usage: <code>/task &lt;description&gt;</code>\n\nDescribe what you want done.",
                { parse_mode: "HTML" },
            )
            return true
        }

        const focusedId = state.focusedSessionId
        if (!focusedId) {
            await ctx.reply("No focused session. Connect a Claude Code session first.", { parse_mode: "HTML" })
            return true
        }

        // Guard: check for existing active task on this session
        const existing = findActiveTaskForSession(focusedId)
        if (existing) {
            await ctx.reply(
                `Session <code>${esc(focusedId)}</code> already has an active task: <b>${esc(existing.id)}</b> (${esc(existing.state)})\n\n`
                + `Cancel it first with /task_cancel_${esc(existing.id)}`,
                { parse_mode: "HTML" },
            )
            return true
        }

        // Find session info for dtach socket and cwd
        const sessions = state.allSessions()
        const sessionInfo = sessions.find(s => s.id === focusedId)
        if (!sessionInfo) {
            await ctx.reply(
                `Could not find session info for <code>${esc(focusedId)}</code>.`,
                { parse_mode: "HTML" },
            )
            return true
        }

        const dtachSocket = sessionInfo.dtachSocket
        if (!dtachSocket) {
            await ctx.reply(
                `Session <code>${esc(focusedId)}</code> has no dtach socket — tasks require a dtach-managed session.\nLaunch one with /new first.`,
                { parse_mode: "HTML" },
            )
            return true
        }

        const cwd = sessionInfo.cwd || HOME

        // Generate task ID from first 6 words
        const shortTitle = description.split(/\s+/).slice(0, 6).join(" ")
        const taskId = generateTaskId(shortTitle)
        const chatId = ctx.chat?.id ?? ctx.from?.id

        // Create the task
        try {
            createTask({
                id: taskId,
                title: shortTitle,
                originalPrompt: description,
                chatId,
                sessionId: focusedId,
                cwd,
                dtachSocket,
            })
            dbg("TASK-CMD", "created task", taskId, "for session", focusedId)
        } catch (e) {
            dbg("TASK-CMD", "createTask failed:", e)
            await ctx.reply(`Failed to create task: ${esc(String(e.message || e))}`, { parse_mode: "HTML" })
            return true
        }

        // Reply with task links
        await ctx.reply(
            `Task <b>${esc(taskId)}</b> created.\n\n`
            + `/task_status_${esc(taskId)} — check status\n`
            + `/task_show_${esc(taskId)} — view details\n`
            + `/task_update_${esc(taskId)} — nudge worker\n`
            + `/task_cancel_${esc(taskId)} — cancel task`,
            { parse_mode: "HTML" },
        )

        // Get HTTP port for the injected prompt
        const port = getHttpPort()
        if (!port) {
            dbg("TASK-CMD", "no HTTP port available, task created but prompt not injected")
            await ctx.reply(
                "Warning: long-task HTTP server not running. Task created but worker prompt was not injected.",
                { parse_mode: "HTML" },
            )
            return true
        }

        const taskDir = `$HOME/.cbg/long-tasks/${taskId}`

        // Build the prompt to inject into the worker session
        const injectedPrompt = [
            `You have been assigned a long-running task. Task ID: ${taskId}`,
            `Task directory: ${taskDir}/`,
            ``,
            `Instructions:`,
            `1. First, write ${taskDir}/context.md summarizing the current project context relevant to this task.`,
            `2. If the task description is ambiguous, ask clarifying questions via the Telegram reply tool. Wait for answers before proceeding.`,
            `3. Once you have enough clarity, write your definition-of-done as markdown and POST it:`,
            `   curl -s -X POST http://localhost:${port}/long-tasks/${taskId}/definition -d @- <<'DEFEOF'`,
            `   (your definition-of-done markdown here)`,
            `   DEFEOF`,
            `4. Then begin implementation. Write ${taskDir}/progress.md as you go, updating it with completed steps.`,
            `5. When finished, write ${taskDir}/report.md with a summary of all changes made.`,
            ``,
            `<user_prompt>`,
            description,
            `</user_prompt>`,
        ].join("\n")

        // Inject via dtach -p
        try {
            const proc = new Deno.Command("dtach", {
                args: ["-p", dtachSocket],
                stdin: "piped",
                stdout: "null",
                stderr: "piped",
            }).spawn()

            const writer = proc.stdin.getWriter()
            await writer.write(new TextEncoder().encode(injectedPrompt + "\n"))
            await writer.close()

            const result = await proc.output()
            if (!result.success) {
                const stderr = new TextDecoder().decode(result.stderr)
                dbg("TASK-CMD", "dtach -p failed:", stderr)
                await ctx.reply(
                    `Task created but failed to inject prompt into worker: <code>${esc(stderr)}</code>`,
                    { parse_mode: "HTML" },
                )
            } else {
                dbg("TASK-CMD", "injected task prompt into session", focusedId)
                appendLog(taskId, "events", { event: "prompt_injected", sessionId: focusedId })
            }
        } catch (e) {
            dbg("TASK-CMD", "dtach -p spawn failed:", e)
            await ctx.reply(
                `Task created but failed to inject prompt: <code>${esc(String(e.message || e))}</code>`,
                { parse_mode: "HTML" },
            )
        }

        return true
    },

    task_list: async (ctx, bot, state) => {
        const tasks = listAllTasks()
        if (tasks.length === 0) {
            await ctx.reply("No tasks found.", { parse_mode: "HTML" })
            return true
        }

        const lines = []
        for (const t of tasks) {
            const ageMs = Date.now() - new Date(t.createdAt).getTime()
            const ageHrs = Math.round(ageMs / (1000 * 60 * 60) * 10) / 10
            const sid = t.worker?.sessionId || "none"
            lines.push(
                `<b>${esc(t.id)}</b> — ${esc(t.state)} — session: ${esc(sid)} — ${ageHrs}h ago`
            )
        }

        await ctx.reply(lines.join("\n"), { parse_mode: "HTML" })
        return true
    },

    task_show: async (ctx, bot, state) => {
        const text = ctx.message?.text || ""
        const taskId = text.replace(/^\/task_show\s*/, "").trim()
        if (!taskId) {
            await ctx.reply("Usage: <code>/task_show &lt;id&gt;</code>", { parse_mode: "HTML" })
            return true
        }

        const task = readTask(taskId)
        if (!task) {
            await ctx.reply(`Task <code>${esc(taskId)}</code> not found.`, { parse_mode: "HTML" })
            return true
        }

        const parts = []
        parts.push(`<b>${esc(task.id)}</b>`)
        parts.push(`Title: ${esc(task.title || "(none)")}`)
        parts.push(`State: ${esc(task.state)}`)
        parts.push(`Session: ${esc(task.worker?.sessionId || "none")}`)
        parts.push(`Created: ${esc(task.createdAt || "unknown")}`)
        if (task.critic) {
            parts.push(`Critic calls: ${task.critic.callCount}`)
        }
        if (task.nudge) {
            parts.push(`Nudges: ${task.nudge.totalNudges}`)
        }

        // Definition (first 500 chars)
        const def = getDefinition(taskId)
        if (def) {
            const truncated = def.length > 500 ? def.slice(0, 500) + "..." : def
            parts.push(`\nDefinition:\n<pre>${esc(truncated)}</pre>`)
        }

        // Tail of critic.log
        const criticLogPath = join(taskPath(taskId), "critic.jsonl")
        const criticTail = await tail(criticLogPath, 5)
        if (criticTail && criticTail.trim()) {
            parts.push(`\nCritic log (last 5 lines):\n<pre>${esc(criticTail)}</pre>`)
        }

        await ctx.reply(parts.join("\n"), { parse_mode: "HTML" })
        return true
    },
}
