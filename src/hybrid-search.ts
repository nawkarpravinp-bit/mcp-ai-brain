/**
 * mcp-ai-brain — Hybrid Search Engine (sql.js compatible)
 *
 * Uses keyword-based search via inverted index table.
 * Scores results with Reciprocal Rank Fusion, recency, and frequency.
 */

import type { SqlJsDatabase } from "./db.js";
import { touchMemory } from "./decay.js";
import { extractKeywords } from "./schema.js";


export interface SearchResult {
  id: number;
  content: string;
  project: string | null;
  category: string;
  tags: string;
  importance: string;
  score: number;
  decay_score: number;
  access_count: number;
  created_at: string;
  updated_at: string;
}

interface MemoryRow {
  id: number;
  content: string;
  project: string | null;
  category: string;
  tags: string;
  importance: string;
  decay_score: number;
  access_count: number;
  created_at: string;
  updated_at: string;
}

/**
 * Recency boost (0-1). Newer = higher.
 */
function recencyBoost(createdAt: string): number {
  const ageMs = Date.now() - new Date(createdAt + "Z").getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.exp(-ageDays / 90);
}

/**
 * Frequency boost (0-1). More accessed = higher.
 */
function frequencyBoost(accessCount: number): number {
  return Math.min(Math.log2(accessCount + 1) / 10, 1.0);
}

/**
 * Keyword search using inverted index.
 */
function keywordSearch(
  db: SqlJsDatabase,
  query: string,
  project: string | null,
  limit: number
): Array<{ id: number; matchCount: number }> {
  const keywords = extractKeywords(query);
  if (keywords.length === 0) return [];

  // Build query to find memories matching any keyword, ranked by match count
  const placeholders = keywords.map(() => "?").join(",");

  let sql = `
    SELECT mk.memory_id as id, COUNT(DISTINCT mk.keyword) as match_count
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

  sql += ` GROUP BY mk.memory_id ORDER BY match_count DESC LIMIT ?`;
  params.push(limit * 2);

  const result = db.exec(sql, params);
  if (result.length === 0) return [];

  return result[0].values.map((row: (string | number | null | Uint8Array)[]) => ({
    id: row[0] as number,
    matchCount: row[1] as number,
  }));
}

/**
 * Vector similarity search using stored local embeddings.
 * Uses dynamic import so it degrades gracefully without @xenova/transformers.
 */
async function vectorSearch(
  db: SqlJsDatabase,
  query: string,
  project: string | null,
  limit: number
): Promise<Array<{ id: number; similarity: number }>> {
  try {
    // Dynamic import — graceful if @xenova/transformers not installed
    const embeddings = await import("./embeddings.js");
    const queryEmbedding = await embeddings.generateEmbedding(query);
    if (!queryEmbedding) return []; // Model not loaded yet

    let sql = `SELECT id, embedding FROM memories WHERE status = 'active' AND embedding IS NOT NULL`;
    const params: (string | number)[] = [];

    if (project) {
      sql += " AND project = ?";
      params.push(project);
    }

    const result = db.exec(sql, params);
    if (result.length === 0 || result[0].values.length === 0) return [];

    const scored: Array<{ id: number; similarity: number }> = [];

    for (const row of result[0].values) {
      const id = row[0] as number;
      const blob = row[1] as Uint8Array | null;
      if (!blob) continue;

      const storedEmbedding = embeddings.deserializeEmbedding(blob);
      const similarity = embeddings.cosineSimilarity(queryEmbedding, storedEmbedding);
      scored.push({ id, similarity });
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, limit * 2);
  } catch {
    return []; // Always degrade gracefully
  }
}

/**
 * Fetch full memory row by ID.
 */
function getMemoryById(db: SqlJsDatabase, id: number): MemoryRow | null {
  const result = db.exec(
    `SELECT id, content, project, category, tags, importance,
            decay_score, access_count, created_at, updated_at
     FROM memories WHERE id = ?`,
    [id]
  );

  if (result.length === 0 || result[0].values.length === 0) return null;

  const row = result[0].values[0];
  return {
    id: row[0] as number,
    content: row[1] as string,
    project: row[2] as string | null,
    category: row[3] as string,
    tags: row[4] as string,
    importance: row[5] as string,
    decay_score: row[6] as number,
    access_count: row[7] as number,
    created_at: row[8] as string,
    updated_at: row[9] as string,
  };
}

/**
 * Hybrid search — keyword + vector, fused with RRF + boosts.
 */
export async function hybridSearch(
  db: SqlJsDatabase,
  query: string,
  options: {
    project?: string | null;
    limit?: number;
    category?: string;
  } = {}
): Promise<SearchResult[]> {
  const { project = null, limit = 10, category } = options;

  const [kwResults, vecResults] = await Promise.all([
    Promise.resolve(keywordSearch(db, query, project, limit)),
    vectorSearch(db, query, project, limit)
  ]);

  const rrfMap = new Map<number, number>();
  const k = 60;

  kwResults.forEach((r, i) => rrfMap.set(r.id, (rrfMap.get(r.id) || 0) + 1 / (k + i + 1)));
  vecResults.forEach((r, i) => rrfMap.set(r.id, (rrfMap.get(r.id) || 0) + 1 / (k + i + 1)));

  const results: SearchResult[] = [];
  for (const [id, score] of Array.from(rrfMap.entries()).sort((a, b) => b[1] - a[1])) {
    const memory = getMemoryById(db, id);
    if (!memory || (category && memory.category !== category)) continue;

    const recency = recencyBoost(memory.created_at);
    const frequency = frequencyBoost(memory.access_count);
    const finalScore = (score * 0.6 + recency * 0.2 + frequency * 0.2) * memory.decay_score;

    touchMemory(db, memory.id);
    results.push({ ...memory, score: finalScore });
  }

  return results.slice(0, limit);
}

/**
 * Simple recall by project/category/importance.
 */
export function recallMemories(
  db: SqlJsDatabase,
  options: {
    project?: string | null;
    category?: string;
    importance?: string;
    limit?: number;
    includeDecayed?: boolean;
  } = {}
): SearchResult[] {
  const {
    project = null,
    category,
    importance,
    limit = 20,
    includeDecayed = false,
  } = options;

  let sql = `
    SELECT id, content, project, category, tags, importance,
           decay_score, access_count, created_at, updated_at
    FROM memories
    WHERE 1=1
  `;
  const params: (string | number)[] = [];

  if (!includeDecayed) {
    sql += " AND status = 'active'";
  }

  if (project) {
    sql += " AND project = ?";
    params.push(project);
  }

  if (category) {
    sql += " AND category = ?";
    params.push(category);
  }

  if (importance) {
    sql += " AND importance = ?";
    params.push(importance);
  }

  sql += " ORDER BY decay_score DESC, updated_at DESC LIMIT ?";
  params.push(limit);

  const result = db.exec(sql, params);
  if (result.length === 0) return [];

  return result[0].values.map((row: (string | number | null | Uint8Array)[]) => {
    const id = row[0] as number;
    touchMemory(db, id);
    return {
      id,
      content: row[1] as string,
      project: row[2] as string | null,
      category: row[3] as string,
      tags: row[4] as string,
      importance: row[5] as string,
      decay_score: row[6] as number,
      access_count: row[7] as number,
      created_at: row[8] as string,
      updated_at: row[9] as string,
      score: row[6] as number,
    };
  });
}
