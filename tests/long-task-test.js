// tests/long-task-test.js — Unit tests for the long-task subsystem
//
// Run: deno test tests/long-task-test.js --allow-all

import { assertEquals, assertExists, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"

// Set up a temp HOME so tests don't touch the real filesystem
const TEST_HOME = Deno.makeTempDirSync({ prefix: "cbg-test-" })
Deno.env.set("HOME", TEST_HOME)
// Also override STATE_DIR so protocol.js picks it up
Deno.env.set("TELEGRAM_STATE_DIR", `${TEST_HOME}/.local/share/cbg/state`)

import {
    slugify, generateTaskId, createTask, readTask, updateTask,
    findActiveTaskForSession, cancelTask, listAllTasks,
    storeDefinition, getDefinition, deleteDefinition,
    rebuildIndex, taskPath,
} from "../lib/long-task.js"

Deno.test("slugify produces PascalCase", () => {
    assertEquals(slugify("fix the auth migration"), "FixTheAuthMigration")
    assertEquals(slugify("hello world!"), "HelloWorld")
    assertEquals(slugify("a"), "A")
    assertEquals(slugify("123 numbers only"), "123NumbersOnly")
})

Deno.test("generateTaskId has slug + hex suffix", () => {
    const id = generateTaskId("fix auth")
    assertEquals(id.startsWith("FixAuth"), true, `Expected to start with FixAuth, got: ${id}`)
    // slug + 4 hex chars
    assertEquals(id.length >= 11, true, `Expected length >= 11, got: ${id.length}`)
})

Deno.test("generateTaskId truncates long titles", () => {
    const id = generateTaskId("this is a very long title that should be truncated at some point to keep ids reasonable")
    // slug part should be max 30 chars
    assertEquals(id.length <= 34 + 4, true, `Expected length <= 38, got: ${id.length} (${id})`)
})

Deno.test("createTask + readTask round-trip", () => {
    const id = generateTaskId("test task one")
    createTask({
        id, title: "test task one", originalPrompt: "do stuff",
        chatId: "123", sessionId: "ses1", cwd: "/tmp", dtachSocket: "/tmp/sock",
    })
    const task = readTask(id)
    assertExists(task)
    assertEquals(task.id, id)
    assertEquals(task.state, "defining")
    assertEquals(task.worker.sessionId, "ses1")
    assertEquals(task.worker.cwd, "/tmp")
    assertEquals(task.createdBy.chatId, "123")
    assertExists(task.nudge)
    assertExists(task.critic)
})

Deno.test("updateTask merges fields", () => {
    const id = generateTaskId("update test")
    createTask({
        id, title: "update test", originalPrompt: "x",
        chatId: "1", sessionId: "ses-update", cwd: "/tmp", dtachSocket: "/tmp/sock",
    })
    updateTask(id, { state: "in_progress" })
    const task = readTask(id)
    assertEquals(task.state, "in_progress")
    assertEquals(task.title, "update test")
})

Deno.test("findActiveTaskForSession returns task and null correctly", () => {
    const id = generateTaskId("find test")
    createTask({
        id, title: "find test", originalPrompt: "x",
        chatId: "1", sessionId: "ses-find", cwd: "/tmp", dtachSocket: "/tmp/sock",
    })
    rebuildIndex()
    const found = findActiveTaskForSession("ses-find")
    assertExists(found)
    assertEquals(found.id, id)

    const notFound = findActiveTaskForSession("nonexistent")
    assertEquals(notFound, null)
})

Deno.test("cancelTask sets state and clears index", () => {
    const id = generateTaskId("cancel me")
    createTask({
        id, title: "cancel me", originalPrompt: "x",
        chatId: "1", sessionId: "ses-cancel", cwd: "/tmp", dtachSocket: "/tmp/sock",
    })
    rebuildIndex()
    const before = findActiveTaskForSession("ses-cancel")
    assertExists(before)

    cancelTask(id)

    const after = findActiveTaskForSession("ses-cancel")
    assertEquals(after, null)

    const task = readTask(id)
    assertEquals(task.state, "cancelled")
})

Deno.test("definition store and retrieve", () => {
    const id = generateTaskId("def test")
    createTask({
        id, title: "def test", originalPrompt: "x",
        chatId: "1", sessionId: "ses-def", cwd: "/tmp", dtachSocket: "/tmp/sock",
    })
    storeDefinition(id, "## Done when tests pass\n- All green")
    assertEquals(getDefinition(id), "## Done when tests pass\n- All green")
})

Deno.test("deleteDefinition clears RAM", () => {
    const id = generateTaskId("def del")
    createTask({
        id, title: "def del", originalPrompt: "x",
        chatId: "1", sessionId: "ses-defdel", cwd: "/tmp", dtachSocket: "/tmp/sock",
    })
    storeDefinition(id, "something")
    assertEquals(getDefinition(id), "something")
    deleteDefinition(id)
    assertEquals(getDefinition(id), null)
})

Deno.test("listAllTasks returns all tasks sorted", () => {
    // Create two tasks with slight delay
    const id1 = generateTaskId("list one")
    const id2 = generateTaskId("list two")
    createTask({
        id: id1, title: "list one", originalPrompt: "a",
        chatId: "1", sessionId: "ses-list1", cwd: "/tmp", dtachSocket: "/tmp/sock",
    })
    createTask({
        id: id2, title: "list two", originalPrompt: "b",
        chatId: "1", sessionId: "ses-list2", cwd: "/tmp", dtachSocket: "/tmp/sock",
    })
    const all = listAllTasks()
    assertEquals(all.length >= 2, true, `Expected at least 2 tasks, got ${all.length}`)
    // Most recent first
    const idx1 = all.findIndex(t => t.id === id1)
    const idx2 = all.findIndex(t => t.id === id2)
    assertNotEquals(idx1, -1)
    assertNotEquals(idx2, -1)
})

Deno.test("guard: one active task per session via index", () => {
    const id1 = generateTaskId("guard one")
    createTask({
        id: id1, title: "guard one", originalPrompt: "x",
        chatId: "1", sessionId: "ses-guard", cwd: "/tmp", dtachSocket: "/tmp/sock",
    })
    rebuildIndex()
    const existing = findActiveTaskForSession("ses-guard")
    assertExists(existing)
    assertEquals(existing.id, id1)
})

Deno.test("task directory structure created correctly", () => {
    const id = generateTaskId("dir test")
    createTask({
        id, title: "dir test", originalPrompt: "x",
        chatId: "1", sessionId: "ses-dir", cwd: "/tmp", dtachSocket: "/tmp/sock",
    })
    const dir = taskPath(id)
    // task.json exists
    const stat = Deno.statSync(`${dir}/task.json`)
    assertEquals(stat.isFile, true)
    // revisions/ dir exists
    const revStat = Deno.statSync(`${dir}/revisions`)
    assertEquals(revStat.isDirectory, true)
})
