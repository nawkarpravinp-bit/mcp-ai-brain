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
 * LIKE-based fallback search for when keyword index misses.
 */
function likeSearch(
  db: SqlJsDatabase,
  query: string,
  project: string | null,
  limit: number
): number[] {
  let sql = `
    SELECT id FROM memories
    WHERE content LIKE ? AND status = 'active'
  `;
  const params: (string | number)[] = [`%${query}%`];

  if (project) {
    sql += " AND project = ?";
    params.push(project);
  }

  sql += " ORDER BY decay_score DESC, access_count DESC LIMIT ?";
  params.push(limit);

  const result = db.exec(sql, params);
  if (result.length === 0) return [];

  return result[0].values.map((row: (string | number | null | Uint8Array)[]) => row[0] as number);
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
 * Hybrid search — keyword + LIKE fallback, scored with RRF + boosts.
 */
export function hybridSearch(
  db: SqlJsDatabase,
  query: string,
  options: {
    project?: string | null;
    limit?: number;
    category?: string;
  } = {}
): SearchResult[] {
  const { project = null, limit = 10, category } = options;

  // Run keyword search
  const kwResults = keywordSearch(db, query, project, limit);

  // If keyword search returned few results, supplement with LIKE
  const kwIds = new Set(kwResults.map((r) => r.id));
  let likeIds: number[] = [];

  if (kwResults.length < limit) {
    likeIds = likeSearch(db, query, project, limit).filter(
      (id) => !kwIds.has(id)
    );
  }

  // Score all results
  const scored: Array<{ id: number; score: number }> = [];
  const maxMatchCount = Math.max(...kwResults.map((r) => r.matchCount), 1);

  // Keyword results get higher base score
  for (const kw of kwResults) {
    scored.push({
      id: kw.id,
      score: (kw.matchCount / maxMatchCount) * 0.7, // 70% weight to keyword relevance
    });
  }

  // LIKE results get lower base score
  for (let i = 0; i < likeIds.length; i++) {
    scored.push({
      id: likeIds[i],
      score: 0.3 / (i + 1), // Diminishing score for LIKE results
    });
  }

  // Fetch full data and apply boosts
  const results: SearchResult[] = [];

  for (const item of scored) {
    const memory = getMemoryById(db, item.id);
    if (!memory) continue;
    if (category && memory.category !== category) continue;

    const recency = recencyBoost(memory.created_at);
    const frequency = frequencyBoost(memory.access_count);

    const finalScore =
      (item.score * 0.6 + recency * 0.2 + frequency * 0.2) *
      memory.decay_score;

    touchMemory(db, memory.id);

    results.push({
      ...memory,
      score: finalScore,
    });
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);
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
