/**
 * mcp-ai-brain — Auto-Learning Engine (v1.1)
 *
 * Automatically extracts structured facts from session summaries
 * and stores them as memories. No manual `remember` calls needed.
 *
 * Handles:
 * - Fact extraction from free-text summaries
 * - Importance inference from keywords
 * - Category classification
 * - Conflict detection & resolution (new fact replaces old)
 * - Deduplication against existing memories
 */

import type { SqlJsDatabase } from "./db.js";
import { indexMemoryKeywords } from "./schema.js";

// ──────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────

export interface ExtractedFact {
  content: string;
  category: string;
  importance: string;
  tags: string[];
}

export interface AutoLearnResult {
  facts_extracted: number;
  facts_stored: number;
  facts_deduplicated: number;
  facts_conflicted: number;
  details: Array<{
    content: string;
    category: string;
    importance: string;
    action: "stored" | "deduplicated" | "conflict_replaced";
  }>;
}

// ──────────────────────────────────────────────────
// Importance Inference
// ──────────────────────────────────────────────────

const CRITICAL_PATTERNS = [
  /production\s+(bug|issue|incident|crash|down)/i,
  /security\s+(vulnerability|breach|fix|patch)/i,
  /data\s+(loss|corruption|leak)/i,
  /breaking\s+change/i,
  /hot\s*fix/i,
  /urgent|emergency|critical/i,
  /api\s+key\s+(changed|rotated|compromised)/i,
  /billing\s+(error|failure|changed)/i,
];

const HIGH_PATTERNS = [
  /architecture|schema|migration/i,
  /deploy(ed|ment|ing)/i,
  /configured?\s+(to|as|with)/i,
  /fixe[sd]|resolve[sd]|patche[sd]/i,
  /stripe|firebase|gemini|vercel/i,
  /cron|schedule|webhook/i,
  /pricing|revenue|subscription/i,
  /domain|dns|ssl/i,
  /new\s+(feature|endpoint|service|page)/i,
];

const LOW_PATTERNS = [
  /ui\s+tweak/i,
  /typo|spelling/i,
  /comment\s+(added|updated)/i,
  /formatting|indent/i,
  /log(ging)?\s+(added|removed)/i,
];

function inferImportance(text: string): string {
  if (CRITICAL_PATTERNS.some((p) => p.test(text))) return "critical";
  if (HIGH_PATTERNS.some((p) => p.test(text))) return "high";
  if (LOW_PATTERNS.some((p) => p.test(text))) return "low";
  return "normal";
}

// ──────────────────────────────────────────────────
// Category Classification
// ──────────────────────────────────────────────────

const CATEGORY_PATTERNS: Array<{ category: string; patterns: RegExp[] }> = [
  {
    category: "architecture",
    patterns: [
      /architect(ure|ural)/i,
      /schema|database|table|collection/i,
      /api\s+(design|contract|endpoint)/i,
      /system\s+design/i,
      /multi-tenant|microservice/i,
      /stack\s*(is|includes|uses)/i,
      /infra(structure)?/i,
    ],
  },
  {
    category: "bug",
    patterns: [
      /bug|error|crash|failure|broken/i,
      /fix(ed|es|ing)?/i,
      /regression|issue|problem/i,
      /root\s+cause/i,
      /debug(ged|ging)?/i,
    ],
  },
  {
    category: "config",
    patterns: [
      /config(ured|uration)?/i,
      /env(ironment)?\s+var/i,
      /setting|parameter/i,
      /cron|schedule/i,
      /\.env|api\s*key/i,
      /timeout|limit|threshold/i,
    ],
  },
  {
    category: "decision",
    patterns: [
      /decid(ed|ing)|decision/i,
      /chose|chosen|picked|selected/i,
      /switched?\s+(to|from)/i,
      /instead\s+of/i,
      /trade-?off/i,
      /because|reason(ing)?/i,
    ],
  },
  {
    category: "pattern",
    patterns: [
      /pattern|approach|strategy/i,
      /best\s+practice/i,
      /template|boilerplate/i,
      /how\s+to|recipe|playbook/i,
    ],
  },
  {
    category: "workflow",
    patterns: [
      /workflow|pipeline|process/i,
      /deploy(ment)?|ci\/?cd/i,
      /step[s]?\s+\d/i,
      /build|test|release/i,
    ],
  },
  {
    category: "incident",
    patterns: [
      /incident|outage|downtime/i,
      /postmortem|post-mortem/i,
      /alert|on-?call/i,
      /recovery|restored/i,
    ],
  },
  {
    category: "preference",
    patterns: [
      /prefer(red|ence)?/i,
      /always\s+use/i,
      /never\s+use/i,
      /convention|standard/i,
    ],
  },
];

function inferCategory(text: string): string {
  let bestCategory = "fact";
  let bestMatchCount = 0;

  for (const group of CATEGORY_PATTERNS) {
    const matchCount = group.patterns.filter((p) => p.test(text)).length;
    if (matchCount > bestMatchCount) {
      bestMatchCount = matchCount;
      bestCategory = group.category;
    }
  }

  return bestCategory;
}

// ──────────────────────────────────────────────────
// Fact Extraction
// ──────────────────────────────────────────────────

/**
 * Split a session summary into individual facts.
 *
 * Strategies:
 * 1. Split on sentence boundaries (. ! ?)
 * 2. Split on bullet points (- * •)
 * 3. Split on numbered lists (1. 2. 3.)
 * 4. Split on newlines with content
 */
export function extractFacts(summary: string): string[] {
  if (!summary || summary.trim().length === 0) return [];

  // Normalize whitespace
  const text = summary.replace(/\r\n/g, "\n").trim();

  // Try bullet/numbered list first (most structured)
  const bulletLines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*•]\s+/.test(line) || /^\d+[.)]\s+/.test(line))
    .map((line) => line.replace(/^[-*•]\s+/, "").replace(/^\d+[.)]\s+/, "").trim());

  if (bulletLines.length >= 2) {
    return bulletLines.filter((line) => line.length > 15);
  }

  // Try sentence splitting
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 15)
    .filter((s) => !/^(the|a|an|this|that|it)\s/i.test(s) || s.length > 40);

  if (sentences.length >= 2) {
    return sentences;
  }

  // Try newline splitting
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 15);

  if (lines.length >= 2) {
    return lines;
  }

  // Single-line summary: store as-is if substantial
  if (text.length > 20) return [text];

  return [];
}

/**
 * Extract tag-worthy terms from a fact.
 */
function extractTags(text: string): string[] {
  const tags: string[] = [];

  // Technology names
  const techPatterns = [
    "firebase", "firestore", "vercel", "stripe", "gemini", "nextjs",
    "react", "node", "typescript", "sqlite", "cloudrun", "printful",
    "resend", "cloudflare", "adsense", "indexnow", "seo", "aeo",
    "webhooks", "cron", "rtdb", "auth", "oauth", "cors",
  ];

  const lower = text.toLowerCase();
  for (const tech of techPatterns) {
    if (lower.includes(tech)) tags.push(tech);
  }

  // Monetary values
  if (/\$\d+/.test(text)) tags.push("money");

  // URLs or domains
  if (/\.(com|org|ai|app|dev|io|ca)\b/.test(text)) tags.push("domain");

  return tags.slice(0, 8); // Cap at 8 tags
}

// ──────────────────────────────────────────────────
// Conflict Detection & Resolution
// ──────────────────────────────────────────────────

/**
 * Find existing memories that might conflict with a new fact.
 * A conflict = same project + overlapping topic but different value.
 *
 * Uses keyword overlap ratio to detect conflicts.
 */
function findConflicts(
  db: SqlJsDatabase,
  fact: string,
  project: string | null
): Array<{ id: number; content: string; overlap: number }> {
  // Get top keyword matches from existing memories
  const keywords = fact
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);

  if (keywords.length === 0) return [];

  const placeholders = keywords.map(() => "?").join(",");

  let sql = `
    SELECT mk.memory_id, COUNT(DISTINCT mk.keyword) as match_count, m.content
    FROM memory_keywords mk
    JOIN memories m ON m.id = mk.memory_id
    WHERE mk.keyword IN (${placeholders})
      AND m.status = 'active'
  `;
  const params: (string | number)[] = [...keywords];

  if (project) {
    sql += " AND m.project = ?";
    params.push(project);
  }

  sql += ` GROUP BY mk.memory_id
           HAVING match_count >= ?
           ORDER BY match_count DESC
           LIMIT 5`;
  params.push(Math.max(2, Math.floor(keywords.length * 0.5)));

  const result = db.exec(sql, params);
  if (result.length === 0) return [];

  return result[0].values.map((row: (string | number | null | Uint8Array)[]) => ({
    id: row[0] as number,
    overlap: row[1] as number,
    content: row[2] as string,
  }));
}

// ──────────────────────────────────────────────────
// Main Auto-Learn Function
// ──────────────────────────────────────────────────

/**
 * Process a session summary and auto-extract memories.
 */
export function autoLearn(
  db: SqlJsDatabase,
  summary: string,
  project: string | null
): AutoLearnResult {
  const facts = extractFacts(summary);

  const result: AutoLearnResult = {
    facts_extracted: facts.length,
    facts_stored: 0,
    facts_deduplicated: 0,
    facts_conflicted: 0,
    details: [],
  };

  for (const factText of facts) {
    const category = inferCategory(factText);
    const importance = inferImportance(factText);
    const tags = extractTags(factText);

    // Check for exact duplicate
    const existing = db.exec(
      `SELECT id FROM memories
       WHERE content = ? AND status = 'active'`,
      [factText]
    );

    if (existing.length > 0 && existing[0].values.length > 0) {
      const existingId = existing[0].values[0][0] as number;
      db.run(
        `UPDATE memories SET access_count = access_count + 1,
                last_accessed = datetime('now'), updated_at = datetime('now')
         WHERE id = ?`,
        [existingId]
      );

      result.facts_deduplicated++;
      result.details.push({
        content: factText.substring(0, 100),
        category,
        importance,
        action: "deduplicated",
      });
      continue;
    }

    // Check for conflicts (similar topic, different value)
    const conflicts = findConflicts(db, factText, project);
    let conflictReplaced = false;

    for (const conflict of conflicts) {
      // High overlap + shorter old content → likely an update
      const overlapRatio = conflict.overlap / Math.max(
        factText.split(/\s+/).length * 0.3, 1
      );

      if (overlapRatio > 0.8) {
        // Replace the old memory
        db.run(
          `UPDATE memories SET status = 'forgotten',
                  updated_at = datetime('now')
           WHERE id = ?`,
          [conflict.id]
        );

        conflictReplaced = true;
        result.facts_conflicted++;
        result.details.push({
          content: factText.substring(0, 100),
          category,
          importance,
          action: "conflict_replaced",
        });
        break;
      }
    }

    // Store the new fact
    const tagsJson = JSON.stringify(tags);
    db.run(
      `INSERT INTO memories (content, project, category, tags, importance)
       VALUES (?, ?, ?, ?, ?)`,
      [factText, project, category, tagsJson, importance]
    );

    const idResult = db.exec("SELECT last_insert_rowid()");
    const memoryId = idResult[0].values[0][0] as number;
    indexMemoryKeywords(db, memoryId, factText, tagsJson);

    if (!conflictReplaced) {
      result.facts_stored++;
      result.details.push({
        content: factText.substring(0, 100),
        category,
        importance,
        action: "stored",
      });
    }
  }

  return result;
}
