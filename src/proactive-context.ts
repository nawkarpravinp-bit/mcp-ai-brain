/**
 * mcp-ai-brain — Proactive Context Engine (v1.2)
 *
 * Automatically detects the active workspace/project and loads
 * the most relevant memories at session start. Zero-prompt context.
 *
 * Features:
 * - Workspace path → project auto-mapping
 * - Smart context window (critical first, then high-signal recent)
 * - Cross-project linking (mentions of other projects pull related memories)
 * - File-aware context (if editing a Stripe file, load payment memories)
 */

import type { SqlJsDatabase } from "./db.js";
import { recallMemories, type SearchResult } from "./hybrid-search.js";
import { runDecayPass } from "./decay.js";
import { randomUUID } from "node:crypto";

// ──────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────

export interface ProactiveContextInput {
  workspace_path?: string;
  active_file?: string;
  project?: string; // explicit override
  limit?: number;
}

export interface ProactiveContextResult {
  session_id: string;
  detected_project: string | null;
  confidence: "exact" | "partial" | "inferred" | "none";
  memories: SearchResult[];
  cross_project_memories: SearchResult[];
  context_signals: string[];
  stats: {
    total_memories: number;
    active_memories: number;
    project_memories: number;
    decay_pass: { updated: number; decayed: number };
  };
}

// ──────────────────────────────────────────────────
// Workspace → Project Mapping
// ──────────────────────────────────────────────────

interface ProjectMapping {
  id: string;
  paths: string[];
  aliases: string[];
}

const PROJECT_MAPPINGS: ProjectMapping[] = [
  {
    id: "my-saas",
    paths: ["my-saas", "saas-app", "saas-platform"],
    aliases: ["saas", "app", "platform"],
  },
  {
    id: "blog-engine",
    paths: ["blog-engine", "content-factory", "auto-blog"],
    aliases: ["blog", "content", "articles"],
  },
  {
    id: "api-service",
    paths: ["api-service", "backend-api", "rest-api"],
    aliases: ["api", "backend", "service"],
  },
  {
    id: "ecommerce",
    paths: ["ecommerce", "shop", "store"],
    aliases: ["shop", "store", "products"],
  },
  {
    id: "mobile-app",
    paths: ["mobile-app", "react-native", "expo-app"],
    aliases: ["mobile", "ios", "android"],
  },
  {
    id: "chrome-extension",
    paths: ["chrome-extension", "browser-extension"],
    aliases: ["extension", "chrome", "browser"],
  },
  {
    id: "seo-tools",
    paths: ["seo-tools", "seo-command-center"],
    aliases: ["seo", "aeo", "indexnow"],
  },
  {
    id: "email-service",
    paths: ["email-service", "email-ops"],
    aliases: ["email", "notifications", "smtp"],
  },
  {
    id: "freelance",
    paths: ["freelance", "client-work"],
    aliases: ["freelance", "client", "proposal"],
  },
  {
    id: "analytics",
    paths: ["analytics", "dashboard"],
    aliases: ["analytics", "metrics", "reporting"],
  },
  {
    id: "project-mgmt",
    paths: ["project-management", "brain"],
    aliases: ["brain", "dashboard", "management"],
  },
  {
    id: "cross-ops",
    paths: ["cross-project"],
    aliases: ["cross-project", "shared", "global"],
  },
];

// ──────────────────────────────────────────────────
// ✏️  CUSTOMIZE YOUR PROJECT MAPPINGS
// ──────────────────────────────────────────────────
// Replace the examples above with your own projects.
// Each entry maps workspace folder paths/aliases → a project ID
// that scopes memories in your brain.db.
//
// Example:
//   { id: "my-startup", paths: ["my-startup", "startup-mvp"], aliases: ["startup", "mvp"] }
//

/**
 * Detect project from workspace path.
 */
function detectProjectFromPath(
  workspacePath: string
): { project: string; confidence: "exact" | "partial" } | null {
  const normalizedPath = workspacePath.toLowerCase().replace(/\\/g, "/");

  for (const mapping of PROJECT_MAPPINGS) {
    for (const pathFragment of mapping.paths) {
      if (normalizedPath.includes(pathFragment)) {
        return { project: mapping.id, confidence: "exact" };
      }
    }
  }

  // Try aliases as partial match
  const pathParts = normalizedPath.split("/").filter(Boolean);
  for (const mapping of PROJECT_MAPPINGS) {
    for (const alias of mapping.aliases) {
      if (pathParts.some((part) => part.includes(alias))) {
        return { project: mapping.id, confidence: "partial" };
      }
    }
  }

  return null;
}

// ──────────────────────────────────────────────────
// File-Aware Context Signals
// ──────────────────────────────────────────────────

interface ContextSignal {
  keywords: string[];
  categories: string[];
}

const FILE_SIGNAL_MAP: Array<{ pattern: RegExp; signal: ContextSignal }> = [
  {
    pattern: /stripe|payment|billing|subscription|webhook/i,
    signal: { keywords: ["stripe", "payment", "webhook", "billing"], categories: ["config", "pattern"] },
  },
  {
    pattern: /firebase|firestore|auth|security\.rules/i,
    signal: { keywords: ["firebase", "firestore", "auth"], categories: ["architecture", "config"] },
  },
  {
    pattern: /gemini|ai|llm|prompt/i,
    signal: { keywords: ["gemini", "ai", "prompt"], categories: ["config", "pattern"] },
  },
  {
    pattern: /deploy|vercel|\.env|ci\/?cd/i,
    signal: { keywords: ["deploy", "vercel", "env"], categories: ["config", "workflow"] },
  },
  {
    pattern: /cron|schedule|job|worker/i,
    signal: { keywords: ["cron", "schedule", "pipeline"], categories: ["config", "workflow"] },
  },
  {
    pattern: /seo|sitemap|robots|meta|schema\.org/i,
    signal: { keywords: ["seo", "sitemap", "indexing"], categories: ["pattern", "config"] },
  },
  {
    pattern: /email|resend|smtp|notification/i,
    signal: { keywords: ["email", "notification", "resend"], categories: ["config", "architecture"] },
  },
  {
    pattern: /test|spec|cypress|jest/i,
    signal: { keywords: ["testing", "qa"], categories: ["pattern", "workflow"] },
  },
  {
    pattern: /css|style|tailwind|design/i,
    signal: { keywords: ["ui", "design", "css"], categories: ["pattern", "preference"] },
  },
  {
    pattern: /api|endpoint|route|handler/i,
    signal: { keywords: ["api", "endpoint"], categories: ["architecture", "pattern"] },
  },
];

function detectFileSignals(filePath: string): ContextSignal {
  const keywords: string[] = [];
  const categories: string[] = [];

  for (const entry of FILE_SIGNAL_MAP) {
    if (entry.pattern.test(filePath)) {
      keywords.push(...entry.signal.keywords);
      categories.push(...entry.signal.categories);
    }
  }

  return {
    keywords: [...new Set(keywords)],
    categories: [...new Set(categories)],
  };
}

// ──────────────────────────────────────────────────
// Cross-Project Linking
// ──────────────────────────────────────────────────

/**
 * Find related projects based on active context.
 * If you're working in GeoQuote and mention "Stripe",
 * pull AYI's Stripe memories too.
 */
function findRelatedProjects(
  primaryProject: string | null,
  signals: ContextSignal
): string[] {
  if (!primaryProject) return [];

  const related: string[] = [];

  // Check which other projects share signal keywords
  for (const mapping of PROJECT_MAPPINGS) {
    if (mapping.id === primaryProject) continue;

    for (const alias of mapping.aliases) {
      if (signals.keywords.some((k) => k.includes(alias) || alias.includes(k))) {
        related.push(mapping.id);
        break;
      }
    }
  }

  // Cross-ops is always relevant
  if (primaryProject !== "cross-ops" && !related.includes("cross-ops")) {
    related.push("cross-ops");
  }

  return related.slice(0, 3); // Max 3 cross-project sources
}

// ──────────────────────────────────────────────────
// Main Proactive Context Function
// ──────────────────────────────────────────────────

export function proactiveSessionStart(
  db: SqlJsDatabase,
  input: ProactiveContextInput
): ProactiveContextResult {
  const { workspace_path, active_file, project: explicitProject, limit = 25 } = input;

  // Step 1: Detect project
  let detectedProject: string | null = explicitProject ?? null;
  let confidence: "exact" | "partial" | "inferred" | "none" = "none";

  if (!detectedProject && workspace_path) {
    const detection = detectProjectFromPath(workspace_path);
    if (detection) {
      detectedProject = detection.project;
      confidence = detection.confidence;
    }
  }

  if (explicitProject) {
    confidence = "exact";
  }

  // Step 2: Run decay maintenance
  const decayResult = runDecayPass(db);

  // Step 3: Create session
  const sessionId = randomUUID();
  db.run(
    "INSERT INTO sessions (id, project, started_at) VALUES (?, ?, datetime('now'))",
    [sessionId, detectedProject]
  );

  // Step 4: Detect file-based context signals
  const signals = active_file ? detectFileSignals(active_file) : { keywords: [], categories: [] };
  const contextSignals: string[] = [];

  if (detectedProject) contextSignals.push(`project:${detectedProject}`);
  if (signals.keywords.length > 0) contextSignals.push(`file_signals:${signals.keywords.join(",")}`);

  // Step 5: Load memories — smart priority order
  const memories: SearchResult[] = [];
  const seenIds = new Set<number>();

  // 5a: Critical memories for this project (always first)
  if (detectedProject) {
    const critical = recallMemories(db, {
      project: detectedProject,
      importance: "critical",
      limit: Math.ceil(limit * 0.3),
    });
    for (const m of critical) {
      if (!seenIds.has(m.id)) {
        seenIds.add(m.id);
        memories.push(m);
      }
    }
  }

  // 5b: High-importance project memories
  if (detectedProject) {
    const high = recallMemories(db, {
      project: detectedProject,
      importance: "high",
      limit: Math.ceil(limit * 0.3),
    });
    for (const m of high) {
      if (!seenIds.has(m.id)) {
        seenIds.add(m.id);
        memories.push(m);
      }
    }
  }

  // 5c: Category-filtered memories based on file signals
  if (detectedProject && signals.categories.length > 0) {
    for (const cat of signals.categories) {
      if (memories.length >= limit) break;
      const catMemories = recallMemories(db, {
        project: detectedProject,
        category: cat,
        limit: 5,
      });
      for (const m of catMemories) {
        if (!seenIds.has(m.id)) {
          seenIds.add(m.id);
          memories.push(m);
        }
      }
    }
  }

  // 5d: Fill remaining with recent project memories
  if (detectedProject && memories.length < limit) {
    const recent = recallMemories(db, {
      project: detectedProject,
      limit: limit - memories.length,
    });
    for (const m of recent) {
      if (!seenIds.has(m.id)) {
        seenIds.add(m.id);
        memories.push(m);
      }
    }
  }

  // 5e: Global critical memories (no project scope)
  if (memories.length < limit) {
    const globalCritical = recallMemories(db, {
      importance: "critical",
      limit: 5,
    });
    for (const m of globalCritical) {
      if (!seenIds.has(m.id)) {
        seenIds.add(m.id);
        memories.push(m);
      }
    }
  }

  // Step 6: Cross-project memories
  const crossProjectMemories: SearchResult[] = [];
  const relatedProjects = findRelatedProjects(detectedProject, signals);

  for (const relProject of relatedProjects) {
    const relMemories = recallMemories(db, {
      project: relProject,
      importance: "critical",
      limit: 3,
    });
    for (const m of relMemories) {
      if (!seenIds.has(m.id)) {
        seenIds.add(m.id);
        crossProjectMemories.push(m);
      }
    }
  }

  if (relatedProjects.length > 0) {
    contextSignals.push(`cross_project:${relatedProjects.join(",")}`);
  }

  // Step 7: Stats
  const totalResult = db.exec("SELECT COUNT(*) FROM memories");
  const total = (totalResult[0]?.values[0]?.[0] as number) ?? 0;

  const activeResult = db.exec("SELECT COUNT(*) FROM memories WHERE status = 'active'");
  const active = (activeResult[0]?.values[0]?.[0] as number) ?? 0;

  let projectCount = 0;
  if (detectedProject) {
    const projResult = db.exec(
      "SELECT COUNT(*) FROM memories WHERE project = ? AND status = 'active'",
      [detectedProject]
    );
    projectCount = (projResult[0]?.values[0]?.[0] as number) ?? 0;
  }

  // Update session with memory count
  db.run("UPDATE sessions SET memories_accessed = ? WHERE id = ?", [
    memories.length + crossProjectMemories.length,
    sessionId,
  ]);

  return {
    session_id: sessionId,
    detected_project: detectedProject,
    confidence,
    memories: memories.slice(0, limit),
    cross_project_memories: crossProjectMemories,
    context_signals: contextSignals,
    stats: {
      total_memories: total,
      active_memories: active,
      project_memories: projectCount,
      decay_pass: decayResult,
    },
  };
}
