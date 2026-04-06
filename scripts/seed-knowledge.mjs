#!/usr/bin/env node

/**
 * Seed script — Migrates Knowledge Items into mcp-ai-brain.
 *
 * Reads each KI's metadata.json and overview.md, then stores them
 * as categorized memories via the brain's MCP protocol over stdio.
 *
 * Usage:
 *   node scripts/seed-knowledge.mjs
 *
 * Environment variables:
 *   KI_DIR       — Path to your knowledge item directory
 *                  Default: ~/.mcp-ai-brain/knowledge
 *   BRAIN_BIN    — Path to the compiled brain index.js
 *                  Default: ./dist/index.js
 *
 * ────────────────────────────────────────────────────────────────
 * Customize the PROJECT_MAP below to match your own projects.
 * Each key = the folder name inside KI_DIR.
 * Each value = { id, name, description } for that project's memories.
 * ────────────────────────────────────────────────────────────────
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { homedir } from "node:os";

const KI_DIR = process.env.KI_DIR ?? join(homedir(), ".mcp-ai-brain", "knowledge");
const BRAIN_CMD = "node";
const BRAIN_ARGS = [process.env.BRAIN_BIN ?? resolve("./dist/index.js")];

// ──────────────────────────────────────────────────
// PROJECT MAP — Customize this for your own projects
// ──────────────────────────────────────────────────
// Key   = folder name inside KI_DIR
// Value = { id, name, description } stored in brain.db
//
// Example entries below. Replace with your own.
const PROJECT_MAP = {
  my_saas_intelligence: {
    id: "my-saas",
    name: "My SaaS App",
    description: "Core SaaS platform — auth, billing, dashboard",
  },
  blog_engine_intelligence: {
    id: "blog-engine",
    name: "Blog Engine",
    description: "Automated multi-site content generation pipeline",
  },
  api_service_intelligence: {
    id: "api-service",
    name: "API Service",
    description: "REST API backend with Firebase and Cloud Functions",
  },
  ecommerce_intelligence: {
    id: "ecommerce",
    name: "E-Commerce Store",
    description: "Print-on-demand storefront with automated fulfillment",
  },
  mobile_app_intelligence: {
    id: "mobile-app",
    name: "Mobile App",
    description: "React Native cross-platform mobile application",
  },
  chrome_extension_intelligence: {
    id: "chrome-extension",
    name: "Chrome Extension",
    description: "Browser extension for productivity and data enrichment",
  },
  seo_tools_intelligence: {
    id: "seo-tools",
    name: "SEO Tools",
    description: "101/10 dual-track ranking methodology — search + AI engines",
  },
  cross_project_operations: {
    id: "cross-ops",
    name: "Cross-Project Operations",
    description: "Shared infrastructure, billing, DNS, incidents across all projects",
  },
  email_service_intelligence: {
    id: "email-service",
    name: "Email Service",
    description: "Shared email infrastructure (Resend, SMTP routing)",
  },
  freelance_operations: {
    id: "freelance",
    name: "Freelance Operations",
    description: "Client proposals and freelance project management",
  },
  unit_economics_intelligence: {
    id: "unit-economics",
    name: "Unit Economics",
    description: "Financial dashboard and unit economic modeling",
  },
  project_management_system: {
    id: "project-mgmt",
    name: "Project Management",
    description: "Project brain concept, HTML dashboard, AI workflow, daily scheduler",
  },
};

// ──────────────────────────────────────────────────
// Read KI data
// ──────────────────────────────────────────────────
function readKI(kiDir) {
  const metaPath = join(kiDir, "metadata.json");
  const overviewPath = join(kiDir, "artifacts", "overview.md");

  let meta = {};
  if (existsSync(metaPath)) {
    try {
      meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    } catch {
      /* ignore parse errors */
    }
  }

  let overview = "";
  if (existsSync(overviewPath)) {
    overview = readFileSync(overviewPath, "utf-8");
  }

  return { meta, overview };
}

// ──────────────────────────────────────────────────
// Build MCP messages
// ──────────────────────────────────────────────────
function buildMessages() {
  const messages = [];
  let id = 1;

  // 1. Initialize
  messages.push({
    jsonrpc: "2.0",
    id: id++,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "seed-script", version: "1.0.0" },
    },
  });

  // 2. Initialized notification
  messages.push({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });

  if (!existsSync(KI_DIR)) {
    console.error(`❌ KI_DIR not found: ${KI_DIR}`);
    console.error("   Set KI_DIR env var to your knowledge directory.");
    process.exit(1);
  }

  // 3. Register all projects
  const kiDirs = readdirSync(KI_DIR).filter((d) => {
    const full = join(KI_DIR, d);
    return existsSync(join(full, "metadata.json")) || existsSync(join(full, "artifacts"));
  });

  for (const dirName of kiDirs) {
    const project = PROJECT_MAP[dirName];
    if (!project) continue;

    messages.push({
      jsonrpc: "2.0",
      id: id++,
      method: "tools/call",
      params: {
        name: "brain_projects_upsert",
        arguments: {
          id: project.id,
          name: project.name,
          description: project.description,
        },
      },
    });
  }

  // 4. Store memories from each KI
  for (const dirName of kiDirs) {
    const project = PROJECT_MAP[dirName];
    if (!project) {
      console.error(`⚠️  No project mapping for KI: ${dirName} — add it to PROJECT_MAP`);
      continue;
    }

    const kiPath = join(KI_DIR, dirName);
    const { meta, overview } = readKI(kiPath);

    // Store the summary from metadata as a critical memory
    if (meta.summary) {
      messages.push({
        jsonrpc: "2.0",
        id: id++,
        method: "tools/call",
        params: {
          name: "brain_remember",
          arguments: {
            content: `[${project.name}] ${meta.summary}`,
            project: project.id,
            category: "architecture",
            importance: "critical",
            tags: ["ki-seed", "summary", dirName],
          },
        },
      });
    }

    // Store the overview (chunked if large) as high-importance
    if (overview) {
      const sections = overview.split(/^## /m).filter(Boolean);

      for (const section of sections) {
        const trimmed = section.trim();
        if (trimmed.length < 20) continue;

        const content =
          trimmed.length > 2000 ? trimmed.substring(0, 2000) + "\n... [truncated]" : trimmed;

        const firstLine = content
          .split("\n")[0]
          .trim()
          .replace(/^#+\s*/, "");

        messages.push({
          jsonrpc: "2.0",
          id: id++,
          method: "tools/call",
          params: {
            name: "brain_remember",
            arguments: {
              content: `[${project.name}] ${content}`,
              project: project.id,
              category: "architecture",
              importance: "high",
              tags: ["ki-seed", "overview", firstLine.substring(0, 50)],
            },
          },
        });
      }
    }

    // Store artifact filenames as a config memory
    const artifactsDir = join(kiPath, "artifacts");
    if (existsSync(artifactsDir)) {
      const artifacts = [];
      function walkDir(dir, prefix = "") {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            walkDir(join(dir, entry.name), prefix + entry.name + "/");
          } else if (entry.name !== "overview.md") {
            artifacts.push(prefix + entry.name);
          }
        }
      }
      walkDir(artifactsDir);

      if (artifacts.length > 0) {
        messages.push({
          jsonrpc: "2.0",
          id: id++,
          method: "tools/call",
          params: {
            name: "brain_remember",
            arguments: {
              content: `[${project.name}] KI artifact files: ${artifacts.join(", ")}`,
              project: project.id,
              category: "config",
              importance: "normal",
              tags: ["ki-seed", "artifacts", "file-inventory"],
            },
          },
        });
      }
    }
  }

  // 5. Final stats call
  messages.push({
    jsonrpc: "2.0",
    id: id++,
    method: "tools/call",
    params: { name: "brain_stats", arguments: {} },
  });

  return messages;
}

// ──────────────────────────────────────────────────
// Execute
// ──────────────────────────────────────────────────
async function main() {
  console.log("🧠 mcp-ai-brain Seed Script");
  console.log("━".repeat(50));
  console.log(`📂 KI_DIR:    ${KI_DIR}`);
  console.log(`🔧 BRAIN_BIN: ${BRAIN_ARGS[0]}`);

  const messages = buildMessages();
  console.log(`📦 Prepared ${messages.length} MCP messages`);

  const brain = spawn(BRAIN_CMD, BRAIN_ARGS, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  brain.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });

  let stderr = "";
  brain.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const payload = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
  brain.stdin.write(payload);
  brain.stdin.end();

  await new Promise((resolve) => {
    brain.on("close", resolve);
  });

  const responses = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  console.log(`✅ Received ${responses.length} responses`);

  const statsResponse = responses[responses.length - 1];
  if (statsResponse?.result?.content?.[0]?.text) {
    const stats = JSON.parse(statsResponse.result.content[0].text);
    console.log("\n📊 Brain Stats After Seeding:");
    console.log(`   Total memories: ${stats.memories.total}`);
    console.log(`   Active: ${stats.memories.active}`);
    console.log("   Categories:");
    for (const cat of stats.categories) {
      console.log(`     ${cat.category}: ${cat.count}`);
    }
    console.log("   Projects:");
    for (const proj of stats.projects) {
      console.log(`     ${proj.project}: ${proj.count} memories`);
    }
  }

  const errors = responses.filter((r) => r?.result?.isError);
  if (errors.length > 0) {
    console.log(`\n⚠️  ${errors.length} errors:`);
    for (const e of errors) {
      console.log(`   ${e.result.content[0].text}`);
    }
  }

  if (stderr) {
    console.log(`\n🔧 Server log: ${stderr.trim()}`);
  }

  console.log("\n" + "━".repeat(50));
  console.log("🎉 Seeding complete!");
}

main().catch(console.error);
