// tests/pure-shell-cwd-test.js
//
// Unit tests for lib/pure/shell-cwd.js — the pure helpers behind the
// `#`-prefix shell-command feature.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { topicShellKey, expandHome, parseShellMessage, resolveCdTarget } from "../lib/pure/shell-cwd.js"

Deno.test("topicShellKey: includes both chat + thread", () => {
    assertEquals(topicShellKey("123", 456), "123:456")
})

Deno.test("topicShellKey: empty thread for DMs", () => {
    assertEquals(topicShellKey("123", null), "123:")
    assertEquals(topicShellKey("123", undefined), "123:")
    assertEquals(topicShellKey("123", ""), "123:")
})

Deno.test("topicShellKey: stringifies numeric chatId", () => {
    assertEquals(topicShellKey(-1003924773219, 19), "-1003924773219:19")
})

Deno.test("expandHome: ~ alone → home", () => {
    assertEquals(expandHome("~", "/Users/jeff"), "/Users/jeff")
})

Deno.test("expandHome: ~/foo → home + /foo", () => {
    assertEquals(expandHome("~/foo", "/Users/jeff"), "/Users/jeff/foo")
})

Deno.test("expandHome: leaves /abs alone", () => {
    assertEquals(expandHome("/etc/passwd", "/Users/jeff"), "/etc/passwd")
})

Deno.test("expandHome: leaves relative paths alone", () => {
    assertEquals(expandHome("foo/bar", "/Users/jeff"), "foo/bar")
})

Deno.test("parseShellMessage: empty body", () => {
    assertEquals(parseShellMessage(""), { kind: "empty" })
    assertEquals(parseShellMessage("   "), { kind: "empty" })
})

Deno.test("parseShellMessage: bare cd", () => {
    assertEquals(parseShellMessage("cd"), { kind: "cd-home" })
    assertEquals(parseShellMessage(" cd "), { kind: "cd-home" })
})

Deno.test("parseShellMessage: cd with arg", () => {
    assertEquals(parseShellMessage("cd /tmp"), { kind: "cd", target: "/tmp" })
    assertEquals(parseShellMessage("cd ~/repos"), { kind: "cd", target: "~/repos" })
    assertEquals(parseShellMessage("cd ../sibling"), { kind: "cd", target: "../sibling" })
})

Deno.test("parseShellMessage: anything else is exec", () => {
    assertEquals(parseShellMessage("ls -la"), { kind: "exec", cmd: "ls -la" })
    assertEquals(parseShellMessage("echo hi | wc -l"), { kind: "exec", cmd: "echo hi | wc -l" })
})

Deno.test("parseShellMessage: leading whitespace stripped from cmd", () => {
    assertEquals(parseShellMessage("  echo hi  "), { kind: "exec", cmd: "echo hi" })
})

Deno.test("resolveCdTarget: absolute target wins", () => {
    assertEquals(resolveCdTarget("/Users/jeff", "/etc/hosts", "/Users/jeff"), "/etc/hosts")
})

Deno.test("resolveCdTarget: ~/path expands", () => {
    assertEquals(resolveCdTarget("/tmp", "~/repos", "/Users/jeff"), "/Users/jeff/repos")
})

Deno.test("resolveCdTarget: relative joins with current cwd", () => {
    assertEquals(resolveCdTarget("/Users/jeff", "repos", "/Users/jeff"), "/Users/jeff/repos")
    assertEquals(resolveCdTarget("/Users/jeff/", "repos", "/Users/jeff"), "/Users/jeff/repos")
})

Deno.test("resolveCdTarget: ../ stays in the path (OS normalizes)", () => {
    assertEquals(resolveCdTarget("/Users/jeff/sub", "..", "/Users/jeff"), "/Users/jeff/sub/..")
})
