/**
 * mcp-ai-brain — Database Schema & Migrations (sql.js compatible)
 *
 * Manages SQLite schema versioning. Each migration is idempotent.
 * Note: sql.js doesn't support FTS5 out of the box, so we use
 * a manual keyword search approach with LIKE + scoring.
 */

import type { SqlJsDatabase } from "./db.js";

interface Migration {
  version: number;
  description: string;
  up: (db: SqlJsDatabase) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "Initial schema — memories, projects, sessions",
    up: (db) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          content TEXT NOT NULL,
          project TEXT,
          category TEXT NOT NULL DEFAULT 'fact',
          tags TEXT DEFAULT '[]',
          importance TEXT NOT NULL DEFAULT 'normal',
          status TEXT NOT NULL DEFAULT 'active',
          access_count INTEGER NOT NULL DEFAULT 0,
          decay_score REAL NOT NULL DEFAULT 1.0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_accessed TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT DEFAULT '',
          metadata TEXT DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          project TEXT,
          summary TEXT,
          memories_created INTEGER NOT NULL DEFAULT 0,
          memories_accessed INTEGER NOT NULL DEFAULT 0,
          started_at TEXT NOT NULL DEFAULT (datetime('now')),
          ended_at TEXT
        );
      `);

      // Indexes for common queries
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);"
      );
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);"
      );
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);"
      );
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);"
      );
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_memories_decay ON memories(decay_score);"
      );
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);"
      );

      // Full-text keyword index (manual inverted index since sql.js lacks FTS5)
      db.run(`
        CREATE TABLE IF NOT EXISTS memory_keywords (
          memory_id INTEGER NOT NULL,
          keyword TEXT NOT NULL,
          FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
        );
      `);
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_keywords_keyword ON memory_keywords(keyword);"
      );
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_keywords_memory ON memory_keywords(memory_id);"
      );

      // Schema version tracking
      db.run(`
        CREATE TABLE IF NOT EXISTS schema_version (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now')),
          description TEXT
        );
      `);
    },
  },
  {
    version: 2,
    description: "Add metrics table for accurate token tracking",
    up: (db) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS metrics (
          key TEXT PRIMARY KEY,
          value_int INTEGER NOT NULL DEFAULT 0,
          value_text TEXT,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);

      // Seed tokens_saved from existing data:
      // For each active memory, tokens at creation = ceil(length/4)
      // Times it was accessed (access_count) = total tokens served
      const existing = db.exec(
        "SELECT COALESCE(SUM(access_count * (LENGTH(content) + 3) / 4), 0) FROM memories"
      );
      const seedTokens = (existing[0]?.values[0]?.[0] as number) ?? 0;

      db.run(
        "INSERT OR REPLACE INTO metrics (key, value_int) VALUES ('tokens_saved', ?)",
        [seedTokens]
      );
      db.run(
        "INSERT OR REPLACE INTO metrics (key, value_int) VALUES ('total_recalls', 0)"
      );
    },
  },
];

/**
 * Extract keywords from text for search indexing.
 * Porter-stemming-lite: lowercases, removes common stop words.
 */
export function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    "a",
    "an",
    "the",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "could",
    "should",
    "may",
    "might",
    "can",
    "shall",
    "to",
    "of",
    "in",
    "for",
    "on",
    "with",
    "at",
    "by",
    "from",
    "as",
    "into",
    "through",
    "during",
    "before",
    "after",
    "above",
    "below",
    "between",
    "out",
    "off",
    "over",
    "under",
    "again",
    "further",
    "then",
    "once",
    "here",
    "there",
    "when",
    "where",
    "why",
    "how",
    "all",
    "each",
    "every",
    "both",
    "few",
    "more",
    "most",
    "other",
    "some",
    "such",
    "no",
    "nor",
    "not",
    "only",
    "own",
    "same",
    "so",
    "than",
    "too",
    "very",
    "just",
    "because",
    "but",
    "and",
    "or",
    "if",
    "while",
    "about",
    "up",
    "it",
    "its",
    "this",
    "that",
    "these",
    "those",
    "i",
    "me",
    "my",
    "we",
    "our",
    "you",
    "your",
    "he",
    "him",
    "his",
    "she",
    "her",
    "they",
    "them",
    "their",
    "what",
    "which",
    "who",
    "whom",
  ]);

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !stopWords.has(word))
    .filter((word, index, arr) => arr.indexOf(word) === index); // dedupe
}

/**
 * Index a memory's keywords.
 */
export function indexMemoryKeywords(
  db: SqlJsDatabase,
  memoryId: number,
  content: string,
  tags: string
): void {
  // Extract keywords from content and tags
  let tagWords: string[] = [];
  try {
    const parsed = JSON.parse(tags);
    if (Array.isArray(parsed)) {
      tagWords = parsed.map((t: string) => t.toLowerCase());
    }
  } catch {
    /* ignore */
  }

  const keywords = [...extractKeywords(content), ...tagWords];

  const stmt = db.prepare(
    "INSERT INTO memory_keywords (memory_id, keyword) VALUES (?, ?)"
  );
  for (const keyword of keywords) {
    stmt.run([memoryId, keyword]);
  }
  stmt.free();
}

/**
 * Run all pending migrations in order.
 */
export function migrate(db: SqlJsDatabase): void {
  // Check if schema_version table exists
  const result = db.exec(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
  );
  const hasVersionTable = result.length > 0 && result[0].values.length > 0;

  let currentVersion = 0;

  if (hasVersionTable) {
    const vResult = db.exec("SELECT MAX(version) as version FROM schema_version");
    if (vResult.length > 0 && vResult[0].values.length > 0) {
      currentVersion = (vResult[0].values[0][0] as number) ?? 0;
    }
  }

  const pending = MIGRATIONS.filter((m) => m.version > currentVersion);

  if (pending.length === 0) {
    return;
  }

  for (const migration of pending) {
    migration.up(db);
    db.run("INSERT INTO schema_version (version, description) VALUES (?, ?)", [
      migration.version,
      migration.description,
    ]);
  }
}

export { MIGRATIONS };
