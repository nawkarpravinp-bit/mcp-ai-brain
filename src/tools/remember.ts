/**
 * Tool: remember — Store a memory with local embedding (v1.1)
 *
 * Stores the memory synchronously, then fire-and-forgets an async
 * embedding generation. If @xenova/transformers isn't available,
 * the memory stores fine with NULL embedding — graceful degradation.
 */

import type { SqlJsDatabase } from "../db.js";
import { persistDb } from "../db.js";
import { indexMemoryKeywords } from "../schema.js";

export interface RememberInput {
  content: string;
  project?: string;
  category?: string;
  tags?: string[];
  importance?: string;
}

export interface RememberResult {
  id: number;
  message: string;
}

export function remember(
  db: SqlJsDatabase,
  input: RememberInput
): RememberResult {
  const {
    content,
    project = null,
    category = "fact",
    tags = [],
    importance = "normal",
  } = input;

  const validImportance = ["critical", "high", "normal", "low"];
  const safeImportance = validImportance.includes(importance)
    ? importance
    : "normal";

  const validCategories = [
    "fact", "decision", "preference", "architecture", "bug",
    "config", "pattern", "incident", "workflow",
  ];
  const safeCategory = validCategories.includes(category) ? category : "fact";

  // Check for exact duplicate
  const existing = db.exec(
    `SELECT id FROM memories
     WHERE project IS ? AND category = ? AND content = ? AND status = 'active'`,
    [project, safeCategory, content]
  );

  if (existing.length > 0 && existing[0].values.length > 0) {
    const existingId = existing[0].values[0][0] as number;
    db.run(
      `UPDATE memories SET access_count = access_count + 1,
              last_accessed = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`,
      [existingId]
    );
    return {
      id: existingId,
      message: `Memory already exists (id: ${existingId}). Updated access count.`,
    };
  }

  // Insert the memory (embedding stored separately, async)
  const tagsJson = JSON.stringify(tags);
  db.run(
    `INSERT INTO memories (content, project, category, tags, importance)
     VALUES (?, ?, ?, ?, ?)`,
    [content, project, safeCategory, tagsJson, safeImportance]
  );

  // Get the last inserted ID
  const idResult = db.exec("SELECT last_insert_rowid()");
  const memoryId = idResult[0].values[0][0] as number;

  // Index keywords for fast keyword search
  indexMemoryKeywords(db, memoryId, content, tagsJson);

  // Fire-and-forget: generate local embedding and store it (v1.1)
  // Does not block the MCP response — updates DB in background
  void (async () => {
    try {
      const embeddings = await import("../embeddings.js");
      const embedding = await embeddings.generateEmbedding(content);
      if (!embedding) return; // Model not available yet

      const blob = embeddings.serializeEmbedding(embedding);
      db.run("UPDATE memories SET embedding = ? WHERE id = ?", [blob, memoryId]);
      persistDb(); // Flush to disk after embedding update
    } catch {
      // Never throw — embedding is optional
    }
  })();

  return {
    id: memoryId,
    message: `Remembered (id: ${memoryId}, category: ${safeCategory}, importance: ${safeImportance})`,
  };
}
