// tests/long-task-test.js — Unit tests for the long-task subsystem
//
// Run: deno test tests/long-task-test.js --allow-all
//
// NOTE: We use dynamic imports below so the env vars (HOME, STATE_DIR)
// are set BEFORE protocol.js / long-task.js load. Static imports are
// hoisted and would see the real HOME, polluting the user's filesystem.

import { assertEquals, assertExists, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"

// Fresh temp HOME per test run
const TEST_HOME = Deno.makeTempDirSync({ prefix: "cbg-test-" })
Deno.env.set("HOME", TEST_HOME)
Deno.env.set("TELEGRAM_STATE_DIR", `${TEST_HOME}/.local/share/cbg/state`)

// Dynamic import — now env vars are in place
const lt = await import("../lib/long-task.js")
const {
    slugify, generateTaskId, createTask, readTask, updateTask,
    findActiveTaskForSession, cancelTask, listAllTasks,
    storeDefinition, getDefinition, deleteDefinition,
    rebuildIndex, taskPath, getTaskDir,
} = lt

Deno.test("task dir is under TEST_HOME", () => {
    const dir = getTaskDir()
    assertEquals(dir.startsWith(TEST_HOME), true, `Expected ${dir} to start with ${TEST_HOME}`)
})

Deno.test("slugify produces PascalCase", () => {
    assertEquals(slugify("fix the auth migration"), "FixTheAuthMigration")
    assertEquals(slugify("hello world!"), "HelloWorld")
    assertEquals(slugify("a"), "A")
    assertEquals(slugify("123 numbers only"), "123NumbersOnly")
})

Deno.test("generateTaskId has slug + hex suffix", () => {
    const id = generateTaskId("fix auth")
    assertEquals(id.startsWith("FixAuth"), true, `Expected to start with FixAuth, got: ${id}`)
    assertEquals(id.length >= 11, true, `Expected length >= 11, got: ${id.length}`)
})

Deno.test("generateTaskId truncates long titles", () => {
    const id = generateTaskId("this is a very long title that should be truncated at some point to keep ids reasonable")
    assertEquals(id.length <= 34 + 4, true, `Expected length <= 38, got: ${id.length} (${id})`)
})

Deno.test("createTask + readTask round-trip", () => {
    const id = generateTaskId("round trip")
    createTask({
        id, title: "round trip", originalPrompt: "do stuff",
        chatId: "123", sessionId: "ses-rt", cwd: "/tmp", dtachSocket: "/tmp/sock",
    })
    const task = readTask(id)
    assertExists(task)
    assertEquals(task.id, id)
    assertEquals(task.state, "defining")
    assertEquals(task.worker.sessionId, "ses-rt")
    assertEquals(task.worker.cwd, "/tmp")
    assertEquals(task.createdBy.chatId, "123")
    assertExists(task.nudge)
    assertExists(task.critic)
})

Deno.test("updateTask merges fields", () => {
    const id = generateTaskId("update")
    createTask({
        id, title: "update", originalPrompt: "x",
        chatId: "1", sessionId: "ses-update", cwd: "/tmp", dtachSocket: "/tmp/sock",
    })
    updateTask(id, { state: "in_progress" })
    const task = readTask(id)
    assertEquals(task.state, "in_progress")
    assertEquals(task.title, "update")
})

Deno.test("findActiveTaskForSession returns task and null correctly", () => {
    const id = generateTaskId("find")
    createTask({
        id, title: "find", originalPrompt: "x",
        chatId: "1", sessionId: "ses-find", cwd: "/tmp", dtachSocket: "/tmp/sock",
    })
    const found = findActiveTaskForSession("ses-find")
    assertExists(found)
    assertEquals(found.id, id)

    const notFound = findActiveTaskForSession("nonexistent-session")
    assertEquals(notFound, null)
})

Deno.test("cancelTask sets state and clears index", () => {
    const id = generateTaskId("cancelme")
    createTask({
        id, title: "cancelme", originalPrompt: "x",
        chatId: "1", sessionId: "ses-cancel", cwd: "/tmp", dtachSocket: "/tmp/sock",
    })
    const before = findActiveTaskForSession("ses-cancel")
    assertExists(before)

    cancelTask(id)

    const after = findActiveTaskForSession("ses-cancel")
    assertEquals(after, null)

    const task = readTask(id)
    assertEquals(task.state, "cancelled")
})

Deno.test("definition store and retrieve", () => {
    const id = generateTaskId("deftest")
    createTask({
        id, title: "deftest", originalPrompt: "x",
        chatId: "1", sessionId: "ses-def", cwd: "/tmp", dtachSocket: "/tmp/sock",
    })
    storeDefinition(id, "## Done when tests pass\n- All green")
    assertEquals(getDefinition(id), "## Done when tests pass\n- All green")
})

Deno.test("deleteDefinition clears RAM", () => {
    const id = generateTaskId("defdel")
    createTask({
        id, title: "defdel", originalPrompt: "x",
        chatId: "1", sessionId: "ses-defdel", cwd: "/tmp", dtachSocket: "/tmp/sock",
    })
    storeDefinition(id, "something")
    assertEquals(getDefinition(id), "something")
    deleteDefinition(id)
    assertEquals(getDefinition(id), null)
})

Deno.test("listAllTasks returns all tasks", () => {
    const id1 = generateTaskId("listone")
    const id2 = generateTaskId("listtwo")
    createTask({
        id: id1, title: "listone", originalPrompt: "a",
        chatId: "1", sessionId: "ses-list1", cwd: "/tmp", dtachSocket: "/tmp/sock",
    })
    createTask({
        id: id2, title: "listtwo", originalPrompt: "b",
        chatId: "1", sessionId: "ses-list2", cwd: "/tmp", dtachSocket: "/tmp/sock",
    })
    const all = listAllTasks()
    const ids = all.map(t => t.id)
    assertEquals(ids.includes(id1), true)
    assertEquals(ids.includes(id2), true)
})

Deno.test("guard: one active task per session via index", () => {
    const id1 = generateTaskId("guardone")
    createTask({
        id: id1, title: "guardone", originalPrompt: "x",
        chatId: "1", sessionId: "ses-guard", cwd: "/tmp", dtachSocket: "/tmp/sock",
    })
    const existing = findActiveTaskForSession("ses-guard")
    assertExists(existing)
    assertEquals(existing.id, id1)
})

Deno.test("cancelled tasks are skipped by findActiveTaskForSession", () => {
    const id1 = generateTaskId("canfirst")
    createTask({
        id: id1, title: "canfirst", originalPrompt: "x",
        chatId: "1", sessionId: "ses-recycle", cwd: "/tmp", dtachSocket: "/tmp/sock",
    })
    cancelTask(id1)
    // After cancel, same session should have no active task — so a new task can be created
    const found = findActiveTaskForSession("ses-recycle")
    assertEquals(found, null)
})

Deno.test("rebuildIndex is idempotent and excludes terminal tasks", () => {
    rebuildIndex()
    // Cancelled tasks from previous test should not be in the index
    const found = findActiveTaskForSession("ses-recycle")
    assertEquals(found, null)
})

Deno.test("task directory structure created correctly", () => {
    const id = generateTaskId("dirtest")
    createTask({
        id, title: "dirtest", originalPrompt: "x",
        chatId: "1", sessionId: "ses-dir", cwd: "/tmp", dtachSocket: "/tmp/sock",
    })
    const dir = taskPath(id)
    const stat = Deno.statSync(`${dir}/task.json`)
    assertEquals(stat.isFile, true)
    const revStat = Deno.statSync(`${dir}/revisions`)
    assertEquals(revStat.isDirectory, true)
})
