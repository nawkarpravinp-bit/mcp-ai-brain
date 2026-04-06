#!/usr/bin/env node

/**
 * 10-Test Validation Suite for mcp-ai-brain
 *
 * Tests: search, recall, project listing, session lifecycle,
 * cross-project search, decay, stats, forget/restore, dedup, persistence.
 *
 * Usage:
 *   node scripts/test-validation.mjs
 *
 * Environment variables:
 *   BRAIN_BIN — Path to compiled brain index.js
 *               Default: ./dist/index.js
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";

const BRAIN = ["node", [process.env.BRAIN_BIN ?? resolve("./dist/index.js")]];

let testNum = 0;
let passed = 0;
let failed = 0;

// ──────────────────────────────────────────────────
// Helper: Send messages to brain & get responses
// ──────────────────────────────────────────────────
async function callBrain(toolCalls) {
  const brain = spawn(BRAIN[0], BRAIN[1], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  brain.stdout.on("data", (c) => (stdout += c.toString()));

  const messages = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
  ];

  let id = 2;
  for (const call of toolCalls) {
    messages.push({
      jsonrpc: "2.0",
      id: id++,
      method: "tools/call",
      params: call,
    });
  }

  brain.stdin.write(messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
  brain.stdin.end();

  await new Promise((resolve) => brain.on("close", resolve));

  return stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .slice(1); // Skip init response
}

function parseResult(response) {
  try {
    return JSON.parse(response.result.content[0].text);
  } catch {
    return null;
  }
}

function assert(condition, testName, detail = "") {
  testNum++;
  if (condition) {
    passed++;
    console.log(`  ✅ Test ${testNum}: ${testName}`);
  } else {
    failed++;
    console.log(`  ❌ Test ${testNum}: ${testName}${detail ? " — " + detail : ""}`);
  }
}

// ──────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────
async function main() {
  console.log("🧪 mcp-ai-brain — 10-Test Validation Suite");
  console.log("━".repeat(55));

  // ─── TEST 1: Cross-project keyword search ───
  console.log("\n📋 Test 1: Cross-project keyword search");
  const r1 = await callBrain([
    { name: "brain_search", arguments: { query: "architecture decision" } },
  ]);
  const s1 = parseResult(r1[0]);
  assert(s1 !== null, "Search executes without error", `count: ${s1?.count}`);

  // ─── TEST 2: Project-scoped recall ───
  console.log("\n📋 Test 2: Project-scoped recall");
  const r2 = await callBrain([
    { name: "brain_projects_list", arguments: {} },
  ]);
  const s2 = parseResult(r2[0]);
  const firstProject = s2?.projects?.[0]?.id ?? null;
  assert(s2 && s2.projects && s2.projects.length > 0, "Projects list is non-empty", `count: ${s2?.projects?.length}`);

  // ─── TEST 3: Recall from first project ───
  console.log("\n📋 Test 3: Project-scoped recall");
  if (firstProject) {
    const r3 = await callBrain([
      { name: "brain_recall", arguments: { project: firstProject, limit: 5 } },
    ]);
    const s3 = parseResult(r3[0]);
    assert(s3 !== null, `Recall for '${firstProject}' executes without error`, `count: ${s3?.count}`);
  } else {
    assert(false, "Project-scoped recall (skipped — no projects found)");
  }

  // ─── TEST 4: Session lifecycle ───
  console.log("\n📋 Test 4: Session start + end lifecycle");
  const r4 = await callBrain([
    { name: "brain_session_start", arguments: { limit: 10 } },
  ]);
  const s4 = parseResult(r4[0]);
  assert(
    s4 && s4.session_id,
    "Session start returns session_id",
    `session: ${s4?.session_id?.substring(0, 8)}, memories: ${s4?.memories?.length}`
  );

  if (s4?.session_id) {
    const r4b = await callBrain([
      { name: "brain_session_end", arguments: { session_id: s4.session_id, summary: "Test session completed" } },
    ]);
    const s4b = parseResult(r4b[0]);
    assert(s4b && s4b.message.includes("Session ended"), "Session end succeeds", s4b?.message);
  } else {
    assert(false, "Session end (skipped — no session_id)");
  }

  // ─── TEST 5: Brain stats ───
  console.log("\n📋 Test 5: Brain stats");
  const r5 = await callBrain([{ name: "brain_stats", arguments: {} }]);
  const s5 = parseResult(r5[0]);
  assert(
    s5 && s5.memories.total >= 0,
    "Stats returns valid memory counts",
    `total: ${s5?.memories?.total}, active: ${s5?.memories?.active}`
  );

  // ─── TEST 6: Remember + deduplication ───
  console.log("\n📋 Test 6: Remember + deduplication");
  const testContent = "Test dedup memory — brain validation " + Date.now();
  const r6a = await callBrain([
    { name: "brain_remember", arguments: { content: testContent, category: "fact", importance: "low" } },
  ]);
  const s6a = parseResult(r6a[0]);
  const firstId = s6a?.id;

  const r6b = await callBrain([
    { name: "brain_remember", arguments: { content: testContent, category: "fact", importance: "low" } },
  ]);
  const s6b = parseResult(r6b[0]);
  assert(
    s6b && s6b.id === firstId && s6b.message.includes("already exists"),
    "Duplicate content returns same ID",
    `first: ${firstId}, second: ${s6b?.id}`
  );

  // ─── TEST 7: Forget + Restore ───
  console.log("\n📋 Test 7: Forget + Restore lifecycle");
  const r7a = await callBrain([
    { name: "brain_forget", arguments: { id: firstId, reason: "test cleanup" } },
  ]);
  const s7a = parseResult(r7a[0]);
  assert(s7a && s7a.success === true, "Forget succeeds", s7a?.message);

  const r7b = await callBrain([
    { name: "brain_restore", arguments: { id: firstId } },
  ]);
  const s7b = parseResult(r7b[0]);
  assert(s7b && s7b.success === true && s7b.message.includes("Restored"), "Restore succeeds", s7b?.message);

  // ─── TEST 8: Category-filtered recall ───
  console.log("\n📋 Test 8: Category-filtered recall");
  const r8 = await callBrain([
    { name: "brain_recall", arguments: { category: "config", limit: 20 } },
  ]);
  const s8 = parseResult(r8[0]);
  assert(
    s8 !== null && (s8.count === 0 || s8.memories.every((m) => m.category === "config")),
    "Config-only recall returns only config memories",
    `count: ${s8?.count}`
  );

  // ─── TEST 9: Smart session start ───
  console.log("\n📋 Test 9: Smart session start (workspace detection)");
  const r9 = await callBrain([
    {
      name: "brain_session_start_smart",
      arguments: { workspace_path: "/home/user/projects/my-saas-app", limit: 5 },
    },
  ]);
  const s9 = parseResult(r9[0]);
  assert(s9 !== null && s9.session_id, "Smart session start executes without error", `detected: ${s9?.detected_project}`);

  // ─── TEST 10: Cross-process persistence ───
  console.log("\n📋 Test 10: Cross-process persistence");
  const uniqueContent = `Persistence test: ${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await callBrain([
    { name: "brain_remember", arguments: { content: uniqueContent, category: "fact", importance: "normal" } },
  ]);

  const r10 = await callBrain([
    { name: "brain_search", arguments: { query: uniqueContent.split(":")[0] } },
  ]);
  const s10 = parseResult(r10[0]);
  const found = s10?.results?.some((r) => r.content.includes("Persistence test"));
  assert(found, "Memory persists across separate processes");

  // ──────────────────────────────────────────────────
  // Summary
  // ──────────────────────────────────────────────────
  console.log("\n" + "━".repeat(55));
  console.log(`\n🏁 Results: ${passed}/${testNum} passed, ${failed} failed`);

  if (failed === 0) {
    console.log("🏆 ALL TESTS PASSED — Brain is production-ready!\n");
  } else {
    console.log(`⚠️  ${failed} test(s) need attention.\n`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(console.error);
